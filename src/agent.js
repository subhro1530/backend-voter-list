/**
 * AI Database Agent - Natural Language Query System
 *
 * A sophisticated AI agent that:
 * - Understands natural language queries about the voter database
 * - Interprets user intent and validates permissions
 * - Generates safe SQL queries (read-only)
 * - Returns results in natural language format
 * - Protects against prompt injection attacks
 *
 * Created by: Shaswata Saha | ssaha.vercel.app
 */

import { query } from "./db.js";

// ============================================================================
// API KEY ROTATION: Use multiple keys for resilience against rate limits
// ============================================================================

const AGENT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Load all available API keys for the agent (primary + fallbacks)
function loadAgentApiKeys() {
  const keys = [];

  // Primary: non-numbered GEMINI_API_KEY
  if (process.env.GEMINI_API_KEY) {
    keys.push({ key: process.env.GEMINI_API_KEY, name: "primary" });
  }

  // Fallback: numbered keys (GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.)
  for (let i = 1; i <= 50; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key) {
      keys.push({ key, name: `key_${i}` });
    }
  }

  // Legacy keys
  const legacyKeys = ["GEMINI_API", "GEMINI_KEY", "GOOGLE_API_KEY"];
  for (const envName of legacyKeys) {
    const key = process.env[envName];
    if (key && !keys.some((k) => k.key === key)) {
      keys.push({ key, name: envName.toLowerCase() });
    }
  }

  console.log(`🤖 Agent loaded ${keys.length} API keys for fallback rotation`);
  return keys;
}

const AGENT_API_KEYS = loadAgentApiKeys();
let currentKeyIndex = 0;
const keyRateLimitUntil = new Map(); // Track when each key can be used again

function getNextAvailableKey() {
  const now = Date.now();

  // Try all keys, starting from current index
  for (let attempt = 0; attempt < AGENT_API_KEYS.length; attempt++) {
    const index = (currentKeyIndex + attempt) % AGENT_API_KEYS.length;
    const keyInfo = AGENT_API_KEYS[index];
    const rateLimitedUntil = keyRateLimitUntil.get(keyInfo.name) || 0;

    if (now >= rateLimitedUntil) {
      currentKeyIndex = (index + 1) % AGENT_API_KEYS.length; // Move to next for round-robin
      return keyInfo;
    }
  }

  // All keys rate limited - find the one that will be available soonest
  let soonestKey = AGENT_API_KEYS[0];
  let soonestTime = keyRateLimitUntil.get(soonestKey.name) || 0;

  for (const keyInfo of AGENT_API_KEYS) {
    const until = keyRateLimitUntil.get(keyInfo.name) || 0;
    if (until < soonestTime) {
      soonestTime = until;
      soonestKey = keyInfo;
    }
  }

  return soonestKey;
}

function markKeyRateLimited(keyName, waitMs = 60000) {
  keyRateLimitUntil.set(keyName, Date.now() + waitMs);
  console.log(`⚠️ Agent key "${keyName}" rate limited for ${waitMs / 1000}s`);
}

// ============================================================================
// SECURITY: Prompt Injection Protection
// ============================================================================

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /forget\s+(all\s+)?previous/i,
  /disregard\s+(all\s+)?prior/i,
  /you\s+are\s+now/i,
  /new\s+instructions:/i,
  /system\s*:\s*/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /assistant:/i,
  /human:/i,
  /user:/i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /TRUNCATE/i,
  /ALTER\s+TABLE/i,
  /CREATE\s+TABLE/i,
  /INSERT\s+INTO/i,
  /UPDATE\s+.*SET/i,
  /GRANT\s+/i,
  /REVOKE\s+/i,
  /;\s*--/,
  /UNION\s+SELECT/i,
  /OR\s+1\s*=\s*1/i,
  /'\s*OR\s*'/i,
  /--\s*$/,
  /\/\*.*\*\//,
  /xp_cmdshell/i,
  /exec\s*\(/i,
  /execute\s*\(/i,
];

const ALLOWED_SQL_PATTERNS = [
  /^SELECT\s/i,
  /^WITH\s/i, // CTEs are allowed
];

const BLOCKED_SQL_KEYWORDS = [
  "DROP",
  "DELETE",
  "TRUNCATE",
  "ALTER",
  "CREATE",
  "INSERT",
  "UPDATE",
  "GRANT",
  "REVOKE",
  "EXECUTE",
  "EXEC",
  "XP_",
];

/**
 * Check for prompt injection attempts
 */
function detectPromptInjection(text) {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        detected: true,
        pattern: pattern.toString(),
        message: "Potential security issue detected in your query",
      };
    }
  }
  return { detected: false };
}

/**
 * Validate that a SQL query is safe (read-only)
 */
function validateSqlSafety(sql) {
  const trimmedSql = sql.trim().toUpperCase();

  // Must start with SELECT or WITH
  const isAllowed = ALLOWED_SQL_PATTERNS.some((p) => p.test(sql.trim()));
  if (!isAllowed) {
    return {
      safe: false,
      reason: "Only SELECT queries are allowed",
    };
  }

  // Check for blocked keywords
  for (const keyword of BLOCKED_SQL_KEYWORDS) {
    if (trimmedSql.includes(keyword)) {
      return {
        safe: false,
        reason: `Blocked keyword detected: ${keyword}`,
      };
    }
  }

  // Check for multiple statements
  const statements = sql.split(";").filter((s) => s.trim().length > 0);
  if (statements.length > 1) {
    return {
      safe: false,
      reason: "Multiple SQL statements are not allowed",
    };
  }

  return { safe: true };
}

/**
 * Sanitize user input
 */
function sanitizeInput(text) {
  if (!text || typeof text !== "string") return "";

  return text
    .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
    .trim()
    .slice(0, 2000); // Limit length
}

// ============================================================================
// DATABASE SCHEMA DEFINITION (for the AI to understand)
// ============================================================================

const DATABASE_SCHEMA = `
DATABASE SCHEMA:

1. TABLE: sessions
   - id (UUID, PRIMARY KEY) - Unique session identifier
   - original_filename (TEXT) - Name of uploaded PDF file
   - status (TEXT) - 'processing', 'completed', 'paused', 'failed'
   - total_pages (INT) - Total number of pages in the PDF
   - processed_pages (INT) - Number of pages processed so far
   - booth_name (TEXT) - Name of the polling station / booth detected from PDF
   - created_at (TIMESTAMP) - When the session was created
   - updated_at (TIMESTAMP) - Last update time

2. TABLE: session_pages
   - id (BIGSERIAL, PRIMARY KEY) - Unique page identifier
   - session_id (UUID, FK → sessions.id) - Reference to parent session
   - page_number (INT) - Page number in the PDF
   - page_path (TEXT) - File path to the page image
   - raw_text (TEXT) - Raw OCR text from the page
   - structured_json (JSONB) - Structured data extracted from the page
   - created_at (TIMESTAMP) - When the page was processed

3. TABLE: session_voters (MAIN DATA TABLE)
   - id (BIGSERIAL, PRIMARY KEY) - Unique voter record identifier
   - session_id (UUID, FK → sessions.id) - Reference to parent session
   - page_id (BIGINT, FK → session_pages.id) - Reference to source page
   - page_number (INT) - Page number where voter was found
   - assembly (TEXT) - Assembly/constituency name
   - part_number (TEXT) - Part number in the voter list
   - section (TEXT) - Section name/number
   - serial_number (TEXT) - Serial number in the voter list
   - voter_id (TEXT) - Official voter ID (e.g., "ABC1234567")
   - name (TEXT) - Voter's full name
   - relation_type (TEXT) - 'father', 'mother', 'husband', 'guardian'
   - relation_name (TEXT) - Name of father/mother/husband/guardian
   - house_number (TEXT) - House/door number
   - age (INT) - Voter's age
   - gender (TEXT) - 'male', 'female', 'other'
   - religion (TEXT) - 'Hindu', 'Muslim', 'Christian', 'Sikh', 'Buddhist', 'Jain', 'Other'
   - photo_url (TEXT) - Cloudinary URL of the voter's photograph (nullable)
   - is_printed (BOOLEAN) - Whether voter slip has been printed
   - printed_at (TIMESTAMP) - When the slip was printed
   - printed_by (BIGINT, FK → users.id) - Who printed the slip
   - created_at (TIMESTAMP) - When the record was created

4. TABLE: users
   - id (BIGSERIAL, PRIMARY KEY) - Unique user identifier
   - email (TEXT, UNIQUE) - User's email address
   - name (TEXT) - User's display name
   - role (TEXT) - 'user' or 'admin'
   - created_at (TIMESTAMP) - When the user was created

5. TABLE: election_sessions
   - id (UUID, PRIMARY KEY) - Unique election result session identifier
   - original_filename (TEXT) - Name of uploaded Form 20 PDF file
   - constituency (TEXT) - Constituency name extracted from OCR
   - total_electors (INT) - Total number of electors in the constituency
   - status (TEXT) - 'processing', 'completed', 'failed'
   - total_pages (INT) - Total pages in the PDF
   - processed_pages (INT) - Pages processed so far
   - created_at (TIMESTAMP) - When the session was created
   - updated_at (TIMESTAMP) - Last update time

6. TABLE: election_pages
   - id (BIGSERIAL, PRIMARY KEY)
   - session_id (UUID, FK → election_sessions.id)
   - page_number (INT)
   - page_path (TEXT)
   - raw_text (TEXT)
   - structured_json (JSONB)
   - created_at (TIMESTAMP)

7. TABLE: election_candidates
   - id (BIGSERIAL, PRIMARY KEY)
   - session_id (UUID, FK → election_sessions.id)
   - candidate_name (TEXT) - Name of the candidate
   - candidate_index (INT) - Order/column index in the result table
   - created_at (TIMESTAMP)
   - UNIQUE(session_id, candidate_name)

8. TABLE: election_booth_results
   - id (BIGSERIAL, PRIMARY KEY)
   - session_id (UUID, FK → election_sessions.id)
   - page_id (BIGINT, FK → election_pages.id)
   - serial_no (INT) - Serial number of the booth row
   - booth_no (TEXT) - Booth/polling station number
   - candidate_votes (JSONB) - { "Candidate A": 312, "Candidate B": 287 }
   - total_valid_votes (INT)
   - rejected_votes (INT)
   - nota (INT) - NOTA votes
   - total_votes (INT)
   - tendered_votes (INT)
   - created_at (TIMESTAMP)

9. TABLE: election_totals
   - id (BIGSERIAL, PRIMARY KEY)
   - session_id (UUID, FK → election_sessions.id)
   - total_type (TEXT) - 'evm', 'postal', or 'total' (CHECK constraint)
   - candidate_votes (JSONB) - Total votes per candidate
   - total_valid_votes (INT)
   - rejected_votes (INT)
   - nota (INT)
   - total_votes (INT)
   - tendered_votes (INT)
   - created_at (TIMESTAMP)
   - UNIQUE(session_id, total_type)

RELATIONSHIPS:
- sessions → session_pages (one-to-many via session_id)
- sessions → session_voters (one-to-many via session_id)
- session_pages → session_voters (one-to-many via page_id)
- users → session_voters (one-to-many via printed_by)
- election_sessions → election_pages (one-to-many via session_id)
- election_sessions → election_candidates (one-to-many via session_id)
- election_sessions → election_booth_results (one-to-many via session_id)
- election_sessions → election_totals (one-to-many via session_id)

COMMON QUERIES:
- Count voters: SELECT COUNT(*) FROM session_voters
- Count by assembly: SELECT assembly, COUNT(*) FROM session_voters GROUP BY assembly
- Count by religion: SELECT religion, COUNT(*) FROM session_voters GROUP BY religion
- Count by gender: SELECT gender, COUNT(*) FROM session_voters GROUP BY gender
- Age statistics: SELECT MIN(age), MAX(age), AVG(age)::INT FROM session_voters WHERE age IS NOT NULL
- Sessions summary: SELECT COUNT(*), SUM(total_pages), SUM(processed_pages) FROM sessions
- Voters with photos: SELECT COUNT(*) FROM session_voters WHERE photo_url IS NOT NULL
- Sessions by booth: SELECT booth_name, COUNT(*) FROM sessions WHERE booth_name IS NOT NULL GROUP BY booth_name
- Election results: SELECT * FROM election_booth_results WHERE session_id = $1 ORDER BY serial_no
- Candidate totals: SELECT ec.candidate_name, et.candidate_votes FROM election_candidates ec JOIN election_totals et ON ec.session_id = et.session_id WHERE ec.session_id = $1
`;

// ============================================================================
// ROLE-BASED PERMISSIONS
// ============================================================================

const ROLE_PERMISSIONS = {
  admin: {
    canQuery: true,
    canViewAllSessions: true,
    canViewVoterDetails: true,
    canViewStatistics: true,
    canViewUserData: true,
    canExportData: true,
    maxResultRows: 1000,
    description: "Full access to all data and statistics",
  },
  user: {
    canQuery: true,
    canViewAllSessions: false, // Can only see sessions they own (future feature)
    canViewVoterDetails: true,
    canViewStatistics: true,
    canViewUserData: false, // Cannot see user table
    canExportData: false,
    maxResultRows: 100,
    description: "Limited access to voter data and statistics",
  },
  guest: {
    canQuery: true,
    canViewAllSessions: false,
    canViewVoterDetails: false, // Only aggregates
    canViewStatistics: true,
    canViewUserData: false,
    canExportData: false,
    maxResultRows: 50,
    description: "Read-only access to aggregate statistics only",
  },
};

/**
 * Get user permissions based on role
 */
export function getUserPermissions(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.guest;
}

// ============================================================================
// INTENT CLASSIFICATION
// ============================================================================

const INTENT_CATEGORIES = {
  COUNT_VOTERS: {
    keywords: ["count", "how many", "total", "number of", "voters"],
    requiresPermission: false,
    sensitivityLevel: "low",
  },
  STATISTICS: {
    keywords: [
      "statistics",
      "stats",
      "average",
      "min",
      "max",
      "distribution",
      "breakdown",
    ],
    requiresPermission: false,
    sensitivityLevel: "low",
  },
  VOTER_SEARCH: {
    keywords: [
      "find",
      "search",
      "look for",
      "who",
      "which voter",
      "voter named",
    ],
    requiresPermission: true,
    sensitivityLevel: "medium",
  },
  VOTER_DETAILS: {
    keywords: ["details", "information about", "tell me about", "show voter"],
    requiresPermission: true,
    sensitivityLevel: "high",
  },
  SESSION_INFO: {
    keywords: ["session", "upload", "pdf", "processing", "file"],
    requiresPermission: false,
    sensitivityLevel: "low",
  },
  ASSEMBLY_INFO: {
    keywords: ["assembly", "constituency", "area", "region", "part"],
    requiresPermission: false,
    sensitivityLevel: "low",
  },
  DEMOGRAPHICS: {
    keywords: ["age", "gender", "religion", "male", "female", "young", "old"],
    requiresPermission: false,
    sensitivityLevel: "low",
  },
  EXPORT_DATA: {
    keywords: ["export", "download", "csv", "excel", "list all"],
    requiresPermission: true,
    sensitivityLevel: "high",
  },
  COMPARISON: {
    keywords: [
      "compare",
      "versus",
      "vs",
      "difference",
      "more than",
      "less than",
    ],
    requiresPermission: false,
    sensitivityLevel: "low",
  },
  HELP: {
    keywords: ["help", "what can you do", "capabilities", "how to", "guide"],
    requiresPermission: false,
    sensitivityLevel: "none",
  },
};

/**
 * Classify user intent from their query
 */
function classifyIntent(queryText) {
  const lowerQuery = queryText.toLowerCase();
  const matchedIntents = [];

  for (const [intent, config] of Object.entries(INTENT_CATEGORIES)) {
    const matchCount = config.keywords.filter((kw) =>
      lowerQuery.includes(kw),
    ).length;
    if (matchCount > 0) {
      matchedIntents.push({ intent, matchCount, ...config });
    }
  }

  // Sort by match count and return top intent
  matchedIntents.sort((a, b) => b.matchCount - a.matchCount);

  return matchedIntents.length > 0
    ? matchedIntents[0]
    : { intent: "GENERAL", requiresPermission: false, sensitivityLevel: "low" };
}

// ============================================================================
// AI AGENT CORE
// ============================================================================

/**
 * Call Gemini API for the agent with automatic key rotation and retry
 */
async function callAgentAI(prompt, systemPrompt, maxRetries = 3) {
  if (AGENT_API_KEYS.length === 0) {
    throw new Error(
      "No agent API keys configured. Set GEMINI_API_KEY or GEMINI_API_KEY_N in .env",
    );
  }

  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const keyInfo = getNextAvailableKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${AGENT_MODEL}:generateContent?key=${keyInfo.key}`;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n---\n\nUser Query: ${prompt}` }],
        },
      ],
      generationConfig: {
        temperature: 0.3, // Lower temperature for more consistent SQL
        topP: 0.8,
        maxOutputTokens: 2048,
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        },
      ],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.status === 429) {
        // Rate limited - mark this key and try another
        markKeyRateLimited(keyInfo.name, 60000); // 60s cooldown
        lastError = new Error(`Rate limited on key ${keyInfo.name}`);
        continue;
      }

      if (response.status === 503) {
        // Service overloaded - short retry
        await new Promise((r) => setTimeout(r, 2000));
        lastError = new Error("Service temporarily unavailable");
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `AI API error: ${response.status} - ${errorText.slice(0, 200)}`,
        );
      }

      const json = await response.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return text.trim();
    } catch (error) {
      if (error.message.includes("429") || error.message.includes("quota")) {
        markKeyRateLimited(keyInfo.name, 60000);
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("All API keys exhausted after retries");
}

/**
 * Generate SQL from natural language query
 */
async function generateSQL(userQuery, userRole, permissions) {
  const systemPrompt = `You are a secure SQL query generator for a voter database system.

CRITICAL SECURITY RULES:
1. Generate ONLY SELECT queries - NO INSERT, UPDATE, DELETE, DROP, or any data modification
2. NEVER include user-provided strings directly in SQL - use parameterized placeholders ($1, $2, etc.)
3. Always use LIMIT clause (max ${permissions.maxResultRows} rows)
4. For user role "${userRole}", apply these restrictions:
   ${!permissions.canViewUserData ? '- DO NOT query the "users" table' : ""}
   ${
     !permissions.canViewVoterDetails
       ? "- Only return aggregate data (COUNT, AVG, SUM) - NO individual voter records"
       : ""
   }
   ${
     !permissions.canViewAllSessions
       ? "- Only show aggregate session statistics"
       : ""
   }

${DATABASE_SCHEMA}

OUTPUT FORMAT:
Return a JSON object with this exact structure (no markdown, no code blocks):
{
  "understood": true/false,
  "intent": "brief description of what user wants",
  "sql": "the SELECT query or null if not possible",
  "params": ["array", "of", "parameters"] or [],
  "explanation": "what this query will return",
  "needsConfirmation": true/false,
  "confirmationMessage": "message to ask user" or null,
  "error": "error message if query cannot be fulfilled" or null
}

EXAMPLES:
- "How many voters are there?" → SELECT COUNT(*) as total_voters FROM session_voters
- "Show voters in assembly X" → SELECT name, voter_id, age, gender FROM session_voters WHERE LOWER(assembly) LIKE LOWER($1) LIMIT 100 with params ["%X%"]
- "Age distribution" → SELECT CASE WHEN age < 30 THEN '18-29' WHEN age < 50 THEN '30-49' ELSE '50+' END as age_group, COUNT(*) FROM session_voters WHERE age IS NOT NULL GROUP BY 1

Generate only valid PostgreSQL syntax.`;

  const response = await callAgentAI(userQuery, systemPrompt);

  // Parse JSON response
  try {
    // Clean up response - remove markdown code blocks if present
    let cleanResponse = response
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();

    return JSON.parse(cleanResponse);
  } catch (e) {
    console.error("Failed to parse AI response:", response);
    return {
      understood: false,
      error: "Failed to understand your query. Please try rephrasing.",
      sql: null,
      params: [],
    };
  }
}

/**
 * Format query results into natural language
 */
async function formatResults(userQuery, results, queryExplanation) {
  if (!results || results.length === 0) {
    return "No data found matching your query.";
  }

  const systemPrompt = `You are a helpful assistant that explains database query results in natural language.

RULES:
1. Be concise but informative
2. Use proper formatting (bullet points, numbers) where appropriate
3. Highlight key insights
4. If there are many results, summarize the top findings
5. Use friendly, professional language
6. Format numbers with proper separators (1,234 not 1234)
7. Use markdown for formatting

USER'S ORIGINAL QUESTION: ${userQuery}
QUERY EXPLANATION: ${queryExplanation}

DATABASE RESULTS (JSON):
${JSON.stringify(results.slice(0, 50), null, 2)}
${results.length > 50 ? `\n... and ${results.length - 50} more rows` : ""}

Provide a natural language summary of these results that directly answers the user's question.`;

  try {
    return await callAgentAI("Format these results", systemPrompt);
  } catch (e) {
    // Fallback to simple formatting
    if (results.length === 1 && Object.keys(results[0]).length <= 3) {
      return Object.entries(results[0])
        .map(([key, value]) => `**${key.replace(/_/g, " ")}**: ${value}`)
        .join("\n");
    }
    return `Found ${
      results.length
    } results. Here's the data:\n\`\`\`json\n${JSON.stringify(
      results.slice(0, 10),
      null,
      2,
    )}\n\`\`\``;
  }
}

/**
 * Get help message for the agent
 */
function getHelpMessage(role) {
  const permissions = getUserPermissions(role);

  return {
    message: `# 🤖 Database Agent Help

I'm your AI assistant for querying the voter database. I understand natural language and can help you with:

## 📊 What I Can Do

### Statistics & Counts
- "How many voters are in the database?"
- "Show me voter count by assembly"
- "What's the gender distribution?"
- "Count voters by religion"
- "Average age of voters"

### Session Information
- "How many sessions have been processed?"
- "Show me session status summary"
- "Which sessions are still processing?"

### Demographics
- "Age distribution of voters"
- "How many male vs female voters?"
- "Religion breakdown by assembly"

${
  permissions.canViewVoterDetails
    ? `### Voter Search (Admin)
- "Find voters named Kumar"
- "Show voters in assembly XYZ"
- "List voters aged 18-25"
- "Find voters with voter ID starting with ABC"`
    : ""
}

${
  permissions.canViewAllSessions
    ? `### Detailed Analysis (Admin)
- "Show me all assemblies"
- "Top 10 assemblies by voter count"
- "Sessions with most voters"`
    : ""
}

## 🔒 Your Access Level: **${role.toUpperCase()}**
${permissions.description}

## 💡 Tips
- Be specific in your questions
- I'll ask for confirmation before running sensitive queries
- All queries are read-only (I can't modify data)
- Results are limited to ${permissions.maxResultRows} rows for performance

Just type your question in plain English!`,
    role,
    permissions,
  };
}

// ============================================================================
// CONVERSATION HISTORY
// ============================================================================

const conversationStore = new Map();
const MAX_HISTORY_LENGTH = 10;
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create conversation history for a user
 */
function getConversation(userId) {
  if (!conversationStore.has(userId)) {
    conversationStore.set(userId, {
      history: [],
      lastActive: Date.now(),
      pendingConfirmation: null,
    });
  }

  const conv = conversationStore.get(userId);
  conv.lastActive = Date.now();

  // Trim old history
  if (conv.history.length > MAX_HISTORY_LENGTH) {
    conv.history = conv.history.slice(-MAX_HISTORY_LENGTH);
  }

  return conv;
}

/**
 * Clean up old conversations
 */
function cleanupConversations() {
  const now = Date.now();
  for (const [userId, conv] of conversationStore.entries()) {
    if (now - conv.lastActive > CONVERSATION_TIMEOUT) {
      conversationStore.delete(userId);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupConversations, 10 * 60 * 1000);

// ============================================================================
// MAIN AGENT FUNCTION
// ============================================================================

/**
 * Process a user query through the agent
 */
export async function processAgentQuery(userQuery, user, options = {}) {
  const startTime = Date.now();
  const userId = user?.id || "anonymous";
  const userRole = user?.role || "guest";
  const permissions = getUserPermissions(userRole);

  // Sanitize input
  const sanitizedQuery = sanitizeInput(userQuery);

  if (!sanitizedQuery) {
    return {
      success: false,
      error: "Please provide a valid query",
      type: "validation_error",
    };
  }

  // Check for prompt injection
  const injectionCheck = detectPromptInjection(sanitizedQuery);
  if (injectionCheck.detected) {
    console.warn(
      `⚠️ Prompt injection attempt from user ${userId}: ${sanitizedQuery.slice(
        0,
        100,
      )}`,
    );
    return {
      success: false,
      error:
        "I couldn't process that query. Please try rephrasing your question.",
      type: "security_error",
    };
  }

  // Check permissions
  if (!permissions.canQuery) {
    return {
      success: false,
      error: "You don't have permission to query the database",
      type: "permission_error",
    };
  }

  // Get conversation
  const conversation = getConversation(userId);

  // Check for pending confirmation
  if (conversation.pendingConfirmation && options.isConfirmation) {
    if (
      sanitizedQuery
        .toLowerCase()
        .match(/^(yes|confirm|proceed|ok|sure|go ahead)/)
    ) {
      // Execute the pending query
      const pending = conversation.pendingConfirmation;
      conversation.pendingConfirmation = null;

      try {
        const result = await query(pending.sql, pending.params);
        const formattedResponse = await formatResults(
          pending.originalQuery,
          result.rows,
          pending.explanation,
        );

        conversation.history.push(
          { role: "user", content: pending.originalQuery },
          { role: "assistant", content: formattedResponse },
        );

        return {
          success: true,
          response: formattedResponse,
          data: result.rows,
          rowCount: result.rowCount,
          executionTime: Date.now() - startTime,
          type: "query_result",
        };
      } catch (e) {
        return {
          success: false,
          error: `Query failed: ${e.message}`,
          type: "execution_error",
        };
      }
    } else {
      // Cancel the pending query
      conversation.pendingConfirmation = null;
      return {
        success: true,
        response: "Query cancelled. What else can I help you with?",
        type: "cancelled",
      };
    }
  }

  // Classify intent
  const intent = classifyIntent(sanitizedQuery);

  // Handle help intent directly
  if (intent.intent === "HELP") {
    return {
      success: true,
      ...getHelpMessage(userRole),
      type: "help",
    };
  }

  // Check if intent requires higher permissions
  if (intent.sensitivityLevel === "high" && !permissions.canViewVoterDetails) {
    return {
      success: false,
      error:
        "This query requires admin access. Please contact an administrator.",
      type: "permission_error",
      intent: intent.intent,
    };
  }

  try {
    // Generate SQL using AI
    const aiResponse = await generateSQL(sanitizedQuery, userRole, permissions);

    if (!aiResponse.understood) {
      return {
        success: false,
        error:
          aiResponse.error ||
          "I couldn't understand your query. Please try rephrasing.",
        type: "understanding_error",
        suggestions: [
          "How many voters are there?",
          "Show voter count by assembly",
          "What's the gender distribution?",
          "Help",
        ],
      };
    }

    if (!aiResponse.sql) {
      return {
        success: false,
        error:
          aiResponse.error || "I couldn't generate a query for this request.",
        type: "generation_error",
      };
    }

    // Validate SQL safety
    const safetyCheck = validateSqlSafety(aiResponse.sql);
    if (!safetyCheck.safe) {
      console.error(`❌ Unsafe SQL detected: ${aiResponse.sql}`);
      return {
        success: false,
        error:
          "I can only run read-only queries. This request would modify data.",
        type: "security_error",
      };
    }

    // Check if confirmation is needed
    if (aiResponse.needsConfirmation && intent.sensitivityLevel !== "low") {
      conversation.pendingConfirmation = {
        sql: aiResponse.sql,
        params: aiResponse.params || [],
        originalQuery: sanitizedQuery,
        explanation: aiResponse.explanation,
      };

      return {
        success: true,
        response:
          aiResponse.confirmationMessage ||
          `I'll run this query: "${aiResponse.explanation}". Is that okay? (yes/no)`,
        type: "confirmation_required",
        intent: aiResponse.intent,
        pendingQuery: {
          explanation: aiResponse.explanation,
        },
      };
    }

    // Execute the query
    console.log(`🔍 Agent executing: ${aiResponse.sql}`);
    console.log(`📝 Params: ${JSON.stringify(aiResponse.params)}`);

    const result = await query(aiResponse.sql, aiResponse.params || []);

    // Format results
    const formattedResponse = await formatResults(
      sanitizedQuery,
      result.rows,
      aiResponse.explanation,
    );

    // Update conversation history
    conversation.history.push(
      { role: "user", content: sanitizedQuery },
      { role: "assistant", content: formattedResponse },
    );

    return {
      success: true,
      response: formattedResponse,
      data: result.rows,
      rowCount: result.rowCount,
      query: {
        intent: aiResponse.intent,
        explanation: aiResponse.explanation,
      },
      executionTime: Date.now() - startTime,
      type: "query_result",
    };
  } catch (error) {
    console.error("Agent error:", error);
    return {
      success: false,
      error: "Something went wrong processing your query. Please try again.",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
      type: "system_error",
    };
  }
}

/**
 * Get agent status and capabilities
 */
export function getAgentStatus() {
  const now = Date.now();
  const availableKeys = AGENT_API_KEYS.filter((k) => {
    const until = keyRateLimitUntil.get(k.name) || 0;
    return now >= until;
  }).length;

  return {
    name: "VoterDB Agent",
    version: "1.1.0",
    model: AGENT_MODEL,
    apiKeyConfigured: AGENT_API_KEYS.length > 0,
    totalApiKeys: AGENT_API_KEYS.length,
    availableApiKeys: availableKeys,
    capabilities: [
      "Natural language database queries",
      "Role-based access control",
      "Aggregate statistics",
      "Voter search (admin only)",
      "Session information",
      "Demographic analysis",
      "Prompt injection protection",
      "Automatic API key rotation",
      "Rate limit resilience",
    ],
    supportedIntents: Object.keys(INTENT_CATEGORIES),
    roles: Object.keys(ROLE_PERMISSIONS).map((role) => ({
      role,
      ...ROLE_PERMISSIONS[role],
    })),
  };
}

/**
 * Get quick suggestions based on role
 */
export function getQuickSuggestions(role) {
  const permissions = getUserPermissions(role);

  const suggestions = [
    "How many voters are in the database?",
    "Show voter count by assembly",
    "What's the gender distribution?",
    "Average age of voters",
    "Count voters by religion",
    "How many sessions are there?",
  ];

  if (permissions.canViewVoterDetails) {
    suggestions.push(
      "Find voters aged 18-25",
      "Show top 10 assemblies by voter count",
      "List voters in assembly [name]",
    );
  }

  return suggestions;
}

export default {
  processAgentQuery,
  getAgentStatus,
  getQuickSuggestions,
  getUserPermissions,
};
