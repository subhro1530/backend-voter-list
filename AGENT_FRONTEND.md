# AI Database Agent - Frontend Implementation Guide

## 🤖 Overview

The AI Database Agent is a sophisticated natural language interface for querying the voter database. It understands plain English questions, validates user permissions, and returns results in a human-readable format.

**Key Features:**

- 🗣️ Natural language query understanding
- 🔒 Role-based access control (admin/user/guest)
- 🛡️ Prompt injection protection
- 📊 Automatic result formatting
- 💬 Conversation context (remembers previous queries)
- ✅ Confirmation for sensitive queries
- ⚡ Quick predefined queries for common operations

---

## 📡 API Endpoints

### 1. Main Query Endpoint

**POST `/agent/query`**

Process a natural language query about the database.

```javascript
// Request
const response = await fetch('/agent/query', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    message: "How many voters are there?",
    isConfirmation: false  // Set true when confirming a pending query
  })
});

// Response Types:

// 1. Successful Query Result
{
  "success": true,
  "response": "There are **12,456** voters in the database.",
  "data": [{ "total": 12456 }],
  "rowCount": 1,
  "query": {
    "intent": "Count all voters",
    "explanation": "SELECT COUNT(*) FROM session_voters"
  },
  "executionTime": 234,
  "type": "query_result"
}

// 2. Confirmation Required
{
  "success": true,
  "response": "I'll search for voters named 'Kumar'. This will return individual voter records. Proceed? (yes/no)",
  "type": "confirmation_required",
  "intent": "Search voters",
  "pendingQuery": {
    "explanation": "Search for voters with name containing 'Kumar'"
  }
}

// 3. Help Response
{
  "success": true,
  "message": "# 🤖 Database Agent Help\n\nI'm your AI assistant...",
  "role": "admin",
  "permissions": { ... },
  "type": "help"
}

// 4. Error Response
{
  "success": false,
  "error": "I couldn't understand your query. Please try rephrasing.",
  "type": "understanding_error",
  "suggestions": [
    "How many voters are there?",
    "Show voter count by assembly",
    "Help"
  ]
}
```

### 2. Agent Status

**GET `/agent/status`**

Get agent capabilities and current user permissions.

```javascript
// Response
{
  "name": "VoterDB Agent",
  "version": "1.0.0",
  "model": "gemini-2.5-flash",
  "apiKeyConfigured": true,
  "capabilities": [
    "Natural language database queries",
    "Role-based access control",
    "Aggregate statistics",
    "Voter search (admin only)",
    "Session information",
    "Demographic analysis",
    "Prompt injection protection"
  ],
  "supportedIntents": [
    "COUNT_VOTERS", "STATISTICS", "VOTER_SEARCH", "VOTER_DETAILS",
    "SESSION_INFO", "ASSEMBLY_INFO", "DEMOGRAPHICS", "EXPORT_DATA",
    "COMPARISON", "HELP"
  ],
  "roles": [...],
  "currentUser": {
    "role": "admin",
    "permissions": {
      "canQuery": true,
      "canViewAllSessions": true,
      "canViewVoterDetails": true,
      "canViewStatistics": true,
      "canViewUserData": true,
      "canExportData": true,
      "maxResultRows": 1000,
      "description": "Full access to all data and statistics"
    }
  }
}
```

### 3. Quick Suggestions

**GET `/agent/suggestions`**

Get role-appropriate query suggestions.

```javascript
// Response
{
  "suggestions": [
    "How many voters are in the database?",
    "Show voter count by assembly",
    "What's the gender distribution?",
    "Average age of voters",
    "Count voters by religion",
    "How many sessions are there?",
    // Admin-only suggestions:
    "Find voters aged 18-25",
    "Show top 10 assemblies by voter count"
  ],
  "role": "admin"
}
```

### 4. Help Endpoint

**GET `/agent/help`**

Get comprehensive help and documentation.

### 5. Confirm Pending Query

**POST `/agent/confirm`**

Confirm or cancel a pending query that requires confirmation.

```javascript
// Request
{
  "confirm": true  // or false to cancel
}

// Response: Same as query result
```

### 6. Query Templates

**GET `/agent/templates`**

Get categorized query templates for quick access.

```javascript
// Response
{
  "templates": {
    "statistics": [
      { "label": "Total Voters", "query": "How many voters are in the database?" },
      { "label": "Voters by Assembly", "query": "Show voter count grouped by assembly" },
      ...
    ],
    "sessions": [...],
    "demographics": [...],
    "admin": [...]  // Only for admins
  },
  "role": "admin"
}
```

### 7. Quick Predefined Queries

**GET `/agent/quick/:queryType`**

Execute predefined safe queries directly (no AI processing).

**Available Query Types:**
| Type | Description | Access |
|------|-------------|--------|
| `total-voters` | Count all voters | All |
| `voters-by-gender` | Gender breakdown | All |
| `voters-by-religion` | Religion breakdown | All |
| `voters-by-assembly` | Top 20 assemblies | All |
| `age-stats` | Min/Max/Avg age | All |
| `session-summary` | Sessions by status | All |
| `total-sessions` | Total session count | All |
| `age-distribution` | Age group breakdown | All |
| `unprinted-count` | Unprinted slip count | Admin |
| `all-assemblies` | All assemblies list | Admin |

```javascript
// Response
{
  "success": true,
  "label": "Total Voters",
  "data": [{ "total": 12456 }],
  "rowCount": 1
}
```

---

## 🎨 React Components

### Agent Chat Component

```jsx
// src/components/AgentChat.jsx
import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function AgentChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const messagesEndRef = useRef(null);

  // Load suggestions on mount
  useEffect(() => {
    loadSuggestions();
    // Add welcome message
    setMessages([
      {
        role: "assistant",
        content:
          '👋 Hi! I\'m the Database Agent. Ask me anything about the voter data!\n\nTry: *"How many voters are there?"* or type **help** for more options.',
        type: "welcome",
      },
    ]);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const getToken = () => localStorage.getItem("token");

  const loadSuggestions = async () => {
    try {
      const res = await fetch(`${API_BASE}/agent/suggestions`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch (e) {
      console.error("Failed to load suggestions:", e);
    }
  };

  const sendMessage = async (text, isConfirmation = false) => {
    if (!text.trim() || loading) return;

    const userMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const endpoint = isConfirmation ? "/agent/confirm" : "/agent/query";
      const body = isConfirmation
        ? { confirm: text.toLowerCase().match(/^(yes|confirm|ok|sure)/) }
        : { message: text, isConfirmation: pendingConfirmation };

      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      // Handle different response types
      let content = "";
      let showData = null;

      if (data.success) {
        if (data.type === "help") {
          content = data.message;
        } else if (data.type === "confirmation_required") {
          content = data.response;
          setPendingConfirmation(true);
        } else if (data.type === "query_result") {
          content = data.response;
          showData = data.data;
          setPendingConfirmation(false);
        } else {
          content = data.response || "Done!";
          setPendingConfirmation(false);
        }
      } else {
        content = `❌ ${data.error || "Something went wrong"}`;
        if (data.suggestions) {
          content +=
            "\n\n**Try these:**\n" +
            data.suggestions.map((s) => `- ${s}`).join("\n");
        }
        setPendingConfirmation(false);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content,
          data: showData,
          type: data.type,
          executionTime: data.executionTime,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "❌ Network error. Please try again.",
          type: "error",
        },
      ]);
      setPendingConfirmation(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input, pendingConfirmation);
  };

  const handleSuggestionClick = (suggestion) => {
    sendMessage(suggestion);
  };

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-24 right-6 w-14 h-14 bg-purple-600 text-white 
                   rounded-full shadow-lg hover:bg-purple-700 transition-all z-50 
                   flex items-center justify-center text-2xl"
        title="AI Database Agent"
      >
        {isOpen ? "✕" : "🤖"}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div
          className="fixed bottom-40 right-6 w-[420px] h-[550px] bg-white rounded-xl 
                        shadow-2xl flex flex-col z-50 border border-gray-200 overflow-hidden"
        >
          {/* Header */}
          <div
            className="px-4 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 
                          text-white flex items-center gap-3"
          >
            <span className="text-2xl">🤖</span>
            <div>
              <div className="font-semibold">Database Agent</div>
              <div className="text-xs opacity-80">
                Ask anything about voter data
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] px-4 py-3 rounded-2xl ${
                    msg.role === "user"
                      ? "bg-purple-600 text-white rounded-br-sm"
                      : "bg-white text-gray-800 shadow-sm border rounded-bl-sm"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>

                      {/* Data Table */}
                      {msg.data && msg.data.length > 0 && (
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-full text-xs border rounded">
                            <thead className="bg-gray-100">
                              <tr>
                                {Object.keys(msg.data[0]).map((key) => (
                                  <th
                                    key={key}
                                    className="px-2 py-1 text-left font-medium"
                                  >
                                    {key.replace(/_/g, " ")}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {msg.data.slice(0, 10).map((row, idx) => (
                                <tr key={idx} className="border-t">
                                  {Object.values(row).map((val, j) => (
                                    <td key={j} className="px-2 py-1">
                                      {typeof val === "number"
                                        ? val.toLocaleString()
                                        : String(val ?? "-")}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {msg.data.length > 10 && (
                            <div className="text-xs text-gray-500 mt-1">
                              Showing 10 of {msg.data.length} rows
                            </div>
                          )}
                        </div>
                      )}

                      {/* Execution Time */}
                      {msg.executionTime && (
                        <div className="text-xs text-gray-400 mt-2">
                          ⚡ {msg.executionTime}ms
                        </div>
                      )}
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {/* Loading */}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-white px-4 py-3 rounded-2xl shadow-sm border">
                  <span className="animate-pulse">🤔 Thinking...</span>
                </div>
              </div>
            )}

            {/* Confirmation Buttons */}
            {pendingConfirmation && !loading && (
              <div className="flex gap-2">
                <button
                  onClick={() => sendMessage("yes", true)}
                  className="px-4 py-2 bg-green-500 text-white rounded-lg 
                           hover:bg-green-600 transition-colors"
                >
                  ✓ Yes, proceed
                </button>
                <button
                  onClick={() => sendMessage("no", true)}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg 
                           hover:bg-gray-300 transition-colors"
                >
                  ✕ Cancel
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Suggestions */}
          {messages.length <= 1 && suggestions.length > 0 && (
            <div className="px-4 py-2 border-t bg-white">
              <div className="text-xs text-gray-500 mb-2">Try asking:</div>
              <div className="flex flex-wrap gap-2">
                {suggestions.slice(0, 4).map((sug, i) => (
                  <button
                    key={i}
                    onClick={() => handleSuggestionClick(sug)}
                    className="px-3 py-1 bg-gray-100 rounded-full text-xs 
                             hover:bg-purple-100 hover:text-purple-700 transition-colors"
                  >
                    {sug}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={handleSubmit}
            className="p-3 border-t bg-white flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                pendingConfirmation
                  ? "Type yes or no..."
                  : "Ask about voter data..."
              }
              disabled={loading}
              className="flex-1 px-4 py-2 border rounded-full focus:ring-2 
                       focus:ring-purple-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-4 py-2 bg-purple-600 text-white rounded-full 
                       hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ➤
            </button>
          </form>
        </div>
      )}
    </>
  );
}
```

### Agent Dashboard Component

```jsx
// src/components/AgentDashboard.jsx
import React, { useState, useEffect } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function AgentDashboard() {
  const [templates, setTemplates] = useState({});
  const [quickResults, setQuickResults] = useState({});
  const [loading, setLoading] = useState({});
  const [agentStatus, setAgentStatus] = useState(null);

  const getToken = () => localStorage.getItem("token");

  useEffect(() => {
    loadTemplates();
    loadAgentStatus();
    // Auto-load common stats
    executeQuickQuery("total-voters");
    executeQuickQuery("voters-by-gender");
    executeQuickQuery("session-summary");
  }, []);

  const loadTemplates = async () => {
    try {
      const res = await fetch(`${API_BASE}/agent/templates`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      setTemplates(data.templates || {});
    } catch (e) {
      console.error("Failed to load templates:", e);
    }
  };

  const loadAgentStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/agent/status`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      setAgentStatus(await res.json());
    } catch (e) {
      console.error("Failed to load agent status:", e);
    }
  };

  const executeQuickQuery = async (queryType) => {
    setLoading((prev) => ({ ...prev, [queryType]: true }));
    try {
      const res = await fetch(`${API_BASE}/agent/quick/${queryType}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      setQuickResults((prev) => ({ ...prev, [queryType]: data }));
    } catch (e) {
      console.error(`Quick query failed (${queryType}):`, e);
    } finally {
      setLoading((prev) => ({ ...prev, [queryType]: false }));
    }
  };

  const StatCard = ({ title, value, icon, color = "blue" }) => (
    <div
      className={`bg-white rounded-xl shadow-lg p-6 border-l-4 border-${color}-500`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-gray-500">{title}</div>
          <div className="text-3xl font-bold text-gray-800">
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
        </div>
        <div className="text-4xl">{icon}</div>
      </div>
    </div>
  );

  const totalVoters = quickResults["total-voters"]?.data?.[0]?.total || 0;
  const genderData = quickResults["voters-by-gender"]?.data || [];
  const sessionData = quickResults["session-summary"]?.data || [];

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-800 flex items-center gap-3">
              <span className="text-4xl">🤖</span>
              AI Database Agent
            </h1>
            <p className="text-gray-500 mt-1">
              Natural language queries for your voter database
            </p>
          </div>
          {agentStatus && (
            <div className="bg-green-100 text-green-700 px-4 py-2 rounded-full text-sm">
              ✓ Agent Online • {agentStatus.model}
            </div>
          )}
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <StatCard
            title="Total Voters"
            value={loading["total-voters"] ? "..." : totalVoters}
            icon="👥"
            color="blue"
          />
          {genderData.slice(0, 2).map((item, i) => (
            <StatCard
              key={item.gender}
              title={item.gender === "male" ? "Male Voters" : "Female Voters"}
              value={loading["voters-by-gender"] ? "..." : item.count}
              icon={item.gender === "male" ? "👨" : "👩"}
              color={item.gender === "male" ? "indigo" : "pink"}
            />
          ))}
          <StatCard
            title="Sessions"
            value={
              loading["session-summary"]
                ? "..."
                : sessionData.reduce((a, s) => a + parseInt(s.count), 0)
            }
            icon="📁"
            color="green"
          />
        </div>

        {/* Query Templates */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {Object.entries(templates).map(([category, items]) => (
            <div key={category} className="bg-white rounded-xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-gray-700 mb-4 capitalize">
                {category === "admin" ? "🔒 " : "📊 "}
                {category} Queries
              </h3>
              <div className="space-y-2">
                {items.map((item, i) => (
                  <button
                    key={i}
                    className="w-full text-left px-4 py-3 bg-gray-50 rounded-lg 
                             hover:bg-purple-50 hover:text-purple-700 transition-colors
                             text-sm"
                  >
                    <div className="font-medium">{item.label}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {item.query}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Permissions Info */}
        {agentStatus?.currentUser && (
          <div className="mt-8 bg-white rounded-xl shadow-lg p-6">
            <h3 className="text-lg font-semibold text-gray-700 mb-4">
              🔑 Your Access Level: {agentStatus.currentUser.role.toUpperCase()}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(agentStatus.currentUser.permissions).map(
                ([key, value]) => {
                  if (typeof value !== "boolean") return null;
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span
                        className={value ? "text-green-500" : "text-red-400"}
                      >
                        {value ? "✓" : "✕"}
                      </span>
                      <span className="text-sm text-gray-600">
                        {key
                          .replace(/([A-Z])/g, " $1")
                          .replace(/^./, (s) => s.toUpperCase())}
                      </span>
                    </div>
                  );
                }
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 🔒 Security Features

### Prompt Injection Protection

The agent detects and blocks:

- "Ignore previous instructions" attacks
- System prompt manipulation
- SQL injection attempts
- Multi-statement injection
- Command injection patterns

### Role-Based Access Control

| Feature                  | Guest | User | Admin |
| ------------------------ | ----- | ---- | ----- |
| Aggregate statistics     | ✅    | ✅   | ✅    |
| Session summaries        | ✅    | ✅   | ✅    |
| Individual voter records | ❌    | ✅   | ✅    |
| All sessions access      | ❌    | ❌   | ✅    |
| User table access        | ❌    | ❌   | ✅    |
| Data export              | ❌    | ❌   | ✅    |
| Max result rows          | 50    | 100  | 1000  |

### SQL Safety Validation

- Only SELECT queries allowed
- Parameterized queries (no string interpolation)
- Blocked keywords: DROP, DELETE, UPDATE, INSERT, etc.
- Single statement only (no semicolon stacking)

---

## 💡 Example Queries

### Statistics

- "How many voters are in the database?"
- "What's the gender distribution?"
- "Show voter count by religion"
- "Average age of voters"

### Demographics

- "How many voters are aged 18-25?"
- "Show age distribution by groups"
- "Count senior voters (60+)"

### Sessions

- "How many sessions have been processed?"
- "Show session status breakdown"
- "Which sessions are still processing?"

### Assemblies

- "List all assemblies"
- "Top 10 assemblies by voter count"
- "How many voters in assembly X?"

### Admin-Only

- "Find voters named Kumar"
- "Show voters with voter ID starting with ABC"
- "Count unprinted voter slips"

---

## 📦 Installation

```bash
npm install react-markdown
```

---

**© 2025 Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app)
