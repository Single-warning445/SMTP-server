require("dotenv").config();

const SMTPServer = require("smtp-server").SMTPServer;
const parser = require("mailparser").simpleParser;
const { Surreal } = require("surrealdb");
const { createClient } = require("@supabase/supabase-js");
const chalk = require("chalk");
const config = require("./config.json");
const process = require("process");
const pLimit = require("p-limit");

// Logging utility
const log = {
  info: (msg) => console.log(chalk.blue("ℹ ") + msg),
  success: (msg) => console.log(chalk.green("✓ ") + msg),
  error: (msg) => console.log(chalk.red("✗ ") + msg),
  warn: (msg) => console.log(chalk.yellow("⚠ ") + msg),
  db: (msg) => console.log(chalk.magenta("📔 ") + msg),
  mail: (msg) => console.log(chalk.cyan("✉ ") + msg),
  smtpIn: (msg) => console.log(chalk.blueBright("[SMTP IN 25] ") + msg),
};

// Supabase client singleton
let supabase = null;
function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key)
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    supabase = createClient(url, key);
  }
  return supabase;
}

// Domain whitelist cache with realtime updates
let domainWhitelist = new Set();

async function initDomainWhitelistRealtime() {
  const supabase = getSupabase();

  // Initial load
  try {
    const { data, error } = await supabase.from("domains").select("domain");
    if (error) throw error;
    domainWhitelist = new Set(data.map((row) => row.domain.toLowerCase()));
    log.success(`[Domains] Loaded ${domainWhitelist.size} whitelisted domains`);
  } catch (err) {
    log.error(`[Domains] Failed initial load: ${err.message}`);
  }

  // Subscribe to changes
  supabase
    .channel("domains-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "domains" },
      (payload) => {
        const domain =
          payload.new?.domain?.toLowerCase() ||
          payload.old?.domain?.toLowerCase();
        if (!domain) return;

        if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
          domainWhitelist.add(domain);
          log.info(`[Domains] Added/Updated: ${domain}`);
        } else if (payload.eventType === "DELETE") {
          domainWhitelist.delete(domain);
          log.warn(`[Domains] Removed: ${domain}`);
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        log.success("[Domains] Realtime subscription active");
      }
    });
}

function isDomainAllowed(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;

  for (const allowed of domainWhitelist) {
    if (domain === allowed || domain.endsWith(`.${allowed}`)) {
      return true;
    }
  }

  return false;
}

// Database connection manager for SurrealDB
class DBConnection {
  static instance = null;
  static reconnectAttempts = 0;
  static MAX_RETRIES = 5;
  static RECONNECT_DELAY = 5000; // 5 seconds

  constructor() {
    this.db = new Surreal();
    this.connected = false;
    this.connectionPromise = null;
  }

  static getInstance() {
    if (!DBConnection.instance) {
      DBConnection.instance = new DBConnection();
    }
    return DBConnection.instance;
  }

  async connect() {
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = (async () => {
      const dbPassword = process.env.DB_PASSWORD;
      if (!dbPassword) {
        throw new Error("DB_PASSWORD environment variable is required");
      }

      try {
        log.db("Connecting to SurrealDB...");
        await this.db.connect(
          process.env.SURREALDB_URL,
          {
            namespace: process.env.SURREALDB_NAMESPACE,
            database: process.env.SURREALDB_DATABASE_NAME,
            auth: { username: process.env.SURREALDB_USERNAME, password: dbPassword },
          }
        );
        this.connected = true;
        log.success("Connected to SurrealDB");
        DBConnection.reconnectAttempts = 0;
        return this.db;
      } catch (e) {
        this.connectionPromise = null;
        this.connected = false;
        throw e;
      }
    })();

    return this.connectionPromise;
  }

  async checkConnection() {
    try {
      await this.db.query("RETURN true;");
      return true;
    } catch (e) {
      return false;
    }
  }

  async query(sql, vars) {
    if (!this.connected || !(await this.checkConnection())) {
      try {
        await this.connect();
      } catch (e) {
        throw new Error("Failed to establish database connection");
      }
    }

    try {
      return await this.db.query(sql, vars);
    } catch (e) {
      if (
        e.message.includes("connection") ||
        e.message.includes("disconnect")
      ) {
        log.warn("Connection lost during query, attempting to reconnect...");
        try {
          await this.connect();
          return await this.db.query(sql, vars);
        } catch (err) {
          throw new Error("Failed to reconnect to database");
        }
      }
      throw e;
    }
  }
}

// Initialize single DB instance
const db = DBConnection.getInstance();

// Keepalive setup
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let keepAliveInterval = null;

function startKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(async () => {
    try {
      await db.query("RETURN true;");
      log.db("DB keepalive ping successful");
    } catch (e) {
      log.warn("DB keepalive failed: " + e.message);
    }
  }, KEEP_ALIVE_INTERVAL_MS);
}

// Email processing
const limit = pLimit(10);
const MAX_QUEUE = 100;
let queue = [];

async function sendHeartbeat() {
  const HEARTBEAT_URL = process.env.HEARTBEAT_URL;
  if (!HEARTBEAT_URL) return;

  try {
    const response = await fetch(HEARTBEAT_URL);
    if (response.ok) log.success("[Heartbeat] Sent successfully");
    else log.warn(`[Heartbeat] Failed: ${response.status}`);
  } catch (error) {
    log.error(`[Heartbeat] Error: ${error.message}`);
  }
}

async function findUserByPrivateEmail(email) {
  try {
    const result = await db.query(
      `SELECT * FROM privateEmail WHERE email = $email LIMIT 1;`,
      { email }
    );
    return result?.[0]?.[0] || null;
  } catch (e) {
    log.error(`DB Error finding private email user: ${e.message}`);
    throw e;
  }
}

async function processEmail(parsed) {
  const recipientEmail = parsed.to?.value?.[0]?.address?.toLowerCase();
  const fromAddress =
    parsed.from?.value?.[0]?.address?.toLowerCase() || "unknown@sender.com";

  // Extra safety check for domain whitelist
  if (!isDomainAllowed(recipientEmail)) {
    log.warn(`[Domains] Email dropped - domain not allowed: ${recipientEmail}`);
    return;
  }

  const queryParams = {
    to: recipientEmail,
    from: fromAddress,
    subject: parsed.subject || "",
    content: parsed.text || "",
    html: parsed.html || "",
  };

  let createQuery = `CREATE email SET to = $to, from = $from, subject = $subject, content = $content, html = $html, createdAt = time::now()`;

  // First check if this is a private email (SurrealDB)
  try {
    const privateUser = await findUserByPrivateEmail(recipientEmail);
    if (privateUser) {
      const [res] = await db.query(`${createQuery} RETURN id;`, queryParams);
      await db.query(
        `UPDATE privateEmail SET lastUpdatedAt = time::now() WHERE email = $email;`,
        { email: recipientEmail }
      );
      log.success(`Saved email for private user: ${res?.[0]?.id}`);
      return;
    }
  } catch (e) {
    log.error(`Error checking private email: ${e.message}`);
  }

  // Handle as temp email: check/create inbox in Supabase
  let inboxId = null;
  try {
    const supabase = getSupabase();
    const { data: existingInbox, error: findError } = await supabase
      .from("inbox")
      .select("id")
      .eq("email_address", recipientEmail)
      .maybeSingle();

    if (findError) throw findError;

    if (existingInbox && existingInbox.id) {
      inboxId = existingInbox.id;
    } else {
      const { data: created, error: createError } = await supabase
        .from("inbox")
        .insert({ email_address: recipientEmail })
        .select("id")
        .maybeSingle();

      if (createError) throw createError;
      inboxId = created?.id;
      log.success(`Created inbox in Supabase: ${inboxId}`);
    }
  } catch (e) {
    log.error(`Supabase inbox error: ${e.message}`);
    return;
  }

  queryParams.inboxId = inboxId;
  const [emailRes] = await db.query(
    `${createQuery}, inbox = $inboxId RETURN id;`,
    queryParams
  );

  log.success(`Saved email: ${emailRes?.[0]?.id}`);
}

// Create SMTP server
function createReceivingServer() {
  return new SMTPServer({
    name: "Cybertemp Mail Receiver",
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],

    // log on new connection
    onConnect(session, callback) {
      log.smtpIn(
        `New connection from ${session.remoteAddress} -> local ${session.localAddress}`
      );
      callback();
    },

    onMailFrom(address, session, callback) {
      if (!address?.address) return callback(new Error("Invalid MAIL FROM"));
      log.smtpIn(
        `MAIL FROM: ${address.address} (client ${session.remoteAddress} -> local ${session.localAddress})`
      );
      callback();
    },

    onRcptTo(address, session, callback) {
      if (!address?.address) return callback(new Error("Invalid RCPT TO"));

      const domainAllowed = isDomainAllowed(address.address);
      if (!domainAllowed) {
        log.warn(
          `[Domains] Rejected RCPT TO: ${address.address} (client ${session.remoteAddress})`
        );
        return callback(new Error("550 Domain not allowed"));
      }

      log.smtpIn(
        `RCPT TO: ${address.address} (client ${session.remoteAddress} -> local ${session.localAddress})`
      );
      callback();
    },

    async onData(stream, session, callback) {
      if (queue.length >= MAX_QUEUE) {
        return callback(new Error("Server busy - try again later"));
      }

      queue.push(1);
      try {
        log.smtpIn(
          `DATA stream started from ${session.remoteAddress} -> local ${session.localAddress}`
        );
        await limit(async () => {
          const parsed = await parser(stream);
          log.smtpIn(
            `Parsed email for ${parsed.to?.text || "unknown"} from ${parsed.from?.text || "unknown"}`
          );
          await processEmail(parsed);
          await sendHeartbeat();
        });
        callback();
      } catch (e) {
        log.error("Email processing failed: " + e.message);
        callback(new Error("Failed to process email"));
      } finally {
        queue.pop();
      }
    },
  });
}


// Main entrypoint
(async () => {
  console.log(
    chalk.cyan("\n=== Cybertemp's SMTP Service (Receive Only) ===\n")
  );

  try {
    // Initialize DB connection
    await db.connect();
    startKeepAlive();

    // Start domain whitelist realtime updates
    await initDomainWhitelistRealtime();

    // Start SMTP server
    const receiverServer = createReceivingServer();
    const receivePort =
      process.env.SMTP_RECEIVE_PORT || config.server?.smtp_server || 25;

    receiverServer.listen(receivePort, "0.0.0.0", () => {
      log.success(`SMTP Receiver running on port ${receivePort}`);
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      log.info("Shutting down gracefully...");
      receiverServer.close(() => {
        log.success("Server closed");
        process.exit(0);
      });
    });
  } catch (e) {
    log.error("Failed to start server: " + e.message);
    process.exit(1);
  }
})();