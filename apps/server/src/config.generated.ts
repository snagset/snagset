// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT BY HAND. It is regenerated with each release
// from the configuration registry, and the boot validator is generated from
// it rather than hand-maintained. A hand-kept copy of an 85-row table is a copy that
// is wrong by the second edit — draft 3 proved it, five variables at once.
// ─────────────────────────────────────────────────────────────────────────────

export interface VarRow {
  readonly name: string;
  readonly type: "int" | "bool" | "url" | "email" | "enum" | "string";
  readonly default: string | null;
  readonly required: boolean;
  readonly oneOf: readonly string[] | null;
  /** Redacted by `snagset doctor` (the last line). */
  readonly secret: boolean;
  /** The subsection it is registered in — printed in errors. */
  readonly section: string;
}

/** 81 variables, parsed. */
export const REGISTRY: readonly VarRow[] = [
  { name: "SNAGSET_BASE_URL", type: "url", default: "http://localhost:8080", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_PORT", type: "int", default: "8080", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_BIND_ADDRESS", type: "string", default: "0.0.0.0", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "DATABASE_URL", type: "url", default: null, required: true, oneOf: null, secret: true, section: "4.2" },
  { name: "SNAGSET_DATABASE_POOL_MAX", type: "int", default: "10", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_DATABASE_SSL", type: "enum", default: "auto", required: false, oneOf: ["auto", "require", "disable"], secret: false, section: "4.2" },
  { name: "SNAGSET_DATA_DIR", type: "string", default: "./.snagset", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_SECRET_KEY", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.2" },
  { name: "SNAGSET_SECRET_KEY_FILE", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_SECRET_KEY_PREVIOUS", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_TRUST_PROXY", type: "int", default: "0", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_ALLOW_INSECURE_BASE_URL", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_LOG_LEVEL", type: "enum", default: "info", required: false, oneOf: ["error", "warn", "info", "debug"], secret: false, section: "4.2" },
  { name: "SNAGSET_LOG_FORMAT", type: "enum", default: "json", required: false, oneOf: ["json", "pretty"], secret: false, section: "4.2" },
  { name: "SNAGSET_METRICS_TOKEN", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_READ_ONLY", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_TELEMETRY", type: "enum", default: "off", required: false, oneOf: ["off"], secret: false, section: "4.2" },
  { name: "SNAGSET_CLOUD", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.2" },
  { name: "SNAGSET_SESSION_TTL_S", type: "int", default: "900", required: false, oneOf: null, secret: false, section: "4.3" },
  { name: "SNAGSET_SESSION_ABSOLUTE_TTL_S", type: "int", default: "43200", required: false, oneOf: null, secret: false, section: "4.3" },
  { name: "SNAGSET_REVIEW_LINK_TTL_DAYS", type: "int", default: "14", required: false, oneOf: null, secret: false, section: "4.3" },
  { name: "SNAGSET_REVIEW_LINK_MAX_TTL_DAYS", type: "int", default: "90", required: false, oneOf: null, secret: false, section: "4.3" },
  { name: "SNAGSET_WRITE_MODE_GRACE_HOURS", type: "int", default: "24", required: false, oneOf: null, secret: false, section: "4.3" },
  { name: "SNAGSET_STORAGE_S3_ENDPOINT", type: "url", default: null, required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_S3_BUCKET", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_S3_REGION", type: "string", default: "auto", required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_S3_ACCESS_KEY_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_S3_SECRET_ACCESS_KEY", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.4" },
  { name: "SNAGSET_STORAGE_S3_FORCE_PATH_STYLE", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_S3_PUBLIC_BASE_URL", type: "url", default: null, required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_ATTACHMENT_ORIGIN", type: "url", default: null, required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_MAX_IMAGE_BYTES", type: "int", default: "262144", required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_MAX_FILE_BYTES", type: "int", default: "104857600", required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_MAX_BODY_BYTES", type: "int", default: "1048576", required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_PROJECT_QUOTA_BYTES", type: "int", default: "268435456", required: false, oneOf: null, secret: false, section: "4.4" },
  { name: "SNAGSET_STORAGE_RETENTION_DAYS", type: "int", default: "0", required: false, oneOf: null, secret: false, section: "4.5" },
  { name: "SNAGSET_EVENT_RETENTION_DAYS", type: "int", default: "90", required: false, oneOf: null, secret: false, section: "4.5" },
  { name: "SNAGSET_ANCHOR_EVENT_RETENTION_DAYS", type: "int", default: "30", required: false, oneOf: null, secret: false, section: "4.5" },
  { name: "SNAGSET_WEBHOOK_DELIVERY_RETENTION_DAYS", type: "int", default: "30", required: false, oneOf: null, secret: false, section: "4.5" },
  { name: "SNAGSET_BOOTSTRAP_OWNER_EMAIL", type: "email", default: null, required: false, oneOf: null, secret: false, section: "4.6" },
  { name: "SNAGSET_BOOTSTRAP_OWNER_PASSWORD_FILE", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.6" },
  { name: "SNAGSET_BOOTSTRAP_PROJECT_NAME", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.6" },
  { name: "SNAGSET_BOOTSTRAP_PROJECT_ORIGINS", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.6" },
  { name: "SNAGSET_WIDGET_CDN_URL", type: "url", default: null, required: false, oneOf: null, secret: false, section: "4.6" },
  { name: "SNAGSET_SIGNUP_OPEN", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.6" },
  { name: "SNAGSET_RATE_LIMIT_ENABLED", type: "bool", default: "true", required: false, oneOf: null, secret: false, section: "4.7" },
  { name: "SNAGSET_RATE_LIMIT_STORE", type: "enum", default: "memory", required: false, oneOf: ["memory", "postgres"], secret: false, section: "4.7" },
  { name: "SNAGSET_RATE_LIMIT_WRITE_PER_MIN", type: "int", default: "60", required: false, oneOf: null, secret: false, section: "4.7" },
  { name: "SNAGSET_RATE_LIMIT_IP_PER_MIN", type: "int", default: "120", required: false, oneOf: null, secret: false, section: "4.7" },
  { name: "SNAGSET_RATE_LIMIT_UPLOAD_PER_HOUR", type: "int", default: "60", required: false, oneOf: null, secret: false, section: "4.7" },
  { name: "SNAGSET_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR", type: "int", default: "26214400", required: false, oneOf: null, secret: false, section: "4.7" },
  { name: "SNAGSET_RATE_LIMIT_ANCHOR_REPORTS_PER_MIN", type: "int", default: "20", required: false, oneOf: null, secret: false, section: "4.7" },
  { name: "SNAGSET_MAIL_URL", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.8" },
  { name: "SNAGSET_MAIL_FROM", type: "email", default: null, required: false, oneOf: null, secret: false, section: "4.8" },
  { name: "SNAGSET_MAIL_NOTIFY", type: "enum", default: "digest", required: false, oneOf: ["digest", "each"], secret: false, section: "4.8" },
  { name: "SNAGSET_ASSIGN_MAIL_DELAY_S", type: "int", default: "3600", required: false, oneOf: null, secret: false, section: "4.8" },
  { name: "SNAGSET_OAUTH_GITHUB_CLIENT_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.8" },
  { name: "SNAGSET_OAUTH_GITHUB_CLIENT_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.8" },
  { name: "SNAGSET_OAUTH_GOOGLE_CLIENT_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.8" },
  { name: "SNAGSET_OAUTH_GOOGLE_CLIENT_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.8" },
  { name: "SNAGSET_GITHUB_APP_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_GITHUB_APP_PRIVATE_KEY_FILE", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_GITHUB_WEBHOOK_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.9" },
  { name: "SNAGSET_GITHUB_CLIENT_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_GITHUB_CLIENT_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.9" },
  { name: "SNAGSET_GITHUB_API_BASE", type: "url", default: "https://api.github.com", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_SLACK_CLIENT_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_SLACK_CLIENT_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.9" },
  { name: "SNAGSET_SLACK_SIGNING_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.9" },
  { name: "SNAGSET_WEBHOOK_EGRESS_ALLOW_PRIVATE", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_WEBHOOKS_ALLOW_HTTP", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_RELAY_URL", type: "url", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_RELAY_ENABLED", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_MCP_HTTP_ENABLED", type: "bool", default: "false", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_LINEAR_CLIENT_ID", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_LINEAR_CLIENT_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.9" },
  { name: "SNAGSET_LINEAR_WEBHOOK_SECRET", type: "string", default: null, required: false, oneOf: null, secret: true, section: "4.9" },
  { name: "SNAGSET_LINEAR_API_BASE", type: "url", default: "https://api.linear.app/graphql", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_SLACK_API_BASE", type: "url", default: "https://slack.com/api", required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_MCP_TOKEN", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
  { name: "SNAGSET_MCP_HOST", type: "string", default: null, required: false, oneOf: null, secret: false, section: "4.9" },
];

/** So an upgrading operator is told what a name BECAME, not that it
 *  is unknown. `to: null` means deleted outright with no replacement. */
export const DELETED: readonly { readonly name: string; readonly to: string | null }[] = [
  { name: "SNAGSET_REDIS_URL", to: "SNAGSET_RATE_LIMIT_STORE" },
  { name: "SNAGSET_PUBLIC_URL", to: "SNAGSET_BASE_URL" },
  { name: "SNAGSET_DATABASE_URL", to: "DATABASE_URL" },
  { name: "SNAGSET_BLOB_DRIVER", to: null },
  { name: "SNAGSET_STORAGE_BACKEND", to: null },
  { name: "SNAGSET_STORAGE_FS_PATH", to: null },
  { name: "SNAGSET_STORAGE_MAX_UPLOAD_BYTES", to: "SNAGSET_STORAGE_MAX_IMAGE_BYTES" },
  { name: "SNAGSET_BLOB_PUBLIC_BASE", to: "SNAGSET_STORAGE_S3_PUBLIC_BASE_URL" },
  { name: "SNAGSET_TRUSTED_PROXY_HOPS", to: "SNAGSET_TRUST_PROXY" },
  { name: "SNAGSET_SMTP_URL", to: "SNAGSET_MAIL_URL" },
  { name: "SNAGSET_SMTP_FROM", to: "SNAGSET_MAIL_FROM" },
  { name: "SNAGSET_RESEND_API_KEY", to: "SNAGSET_MAIL_URL" },
  { name: "SNAGSET_ENCRYPTION_KEY", to: null },
  { name: "SNAGSET_SESSION_SECRET", to: null },
  { name: "SNAGSET_PANIC", to: "SNAGSET_READ_ONLY" },
  { name: "SNAGSET_PURGE_AFTER_DAYS", to: "SNAGSET_STORAGE_RETENTION_DAYS" },
  { name: "SNAGSET_INTEGRATION_IMAGE_REF_TTL_DAYS", to: "SNAGSET_ATTACHMENT_SHARE_TTL_DAYS" },
  { name: "SNAGSET_GITHUB_APP_PRIVATE_KEY", to: "SNAGSET_GITHUB_APP_PRIVATE_KEY_FILE" },
  { name: "SNAGSET_DEFAULT_HOST", to: null },
  { name: "SNAGSET_PRODUCTION_TOKEN_MODE", to: null },
  { name: "SNAGSET_ORIGINAL", to: "SYM_ORIGINAL" },
  { name: "SNAGSET_WRAPPED", to: "SYM_ORIGINAL" },
  { name: "SNAGSET_MIGRATE_ON_BOOT", to: null },
];
