# Frontend Changes Required

**For: Voter List Management System Frontend**
**Backend Version: 2.1.0 with Conservative Sequential Processing**
**Created by: Shaswata Saha | ssaha.vercel.app**

---

## 🎯 Summary of Backend Changes

The backend has been upgraded with:

1. **7 API Engines** with sequential processing (conservative rate limiting)
2. **Stop Processing** button to cancel ongoing OCR
3. **Session Rename** functionality
4. **Intelligent NLP Chatbot** that understands natural language
5. **Enhanced API status tracking** with per-engine metrics + rate_limited state
6. **System info endpoint** with author credits
7. **Graceful shutdown** - pauses all processing sessions when server stops

### ⚠️ Important Processing Notes:

- Processing is **sequential** (~30 seconds per page) to respect Gemini API rate limits
- A 40-page PDF takes approximately 20 minutes to process
- Users can **stop** and **resume** processing anytime

---

## 📝 Required Frontend Changes

### 1. **Add Sticky Footer with Credits**

Add a fixed footer at the bottom of every page:

```jsx
// components/Footer.jsx
const Footer = () => {
  return (
    <footer className="fixed bottom-0 left-0 right-0 bg-gray-900 text-white py-3 text-center z-50">
      <p className="text-sm">
        Created by{" "}
        <a
          href="https://ssaha.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 font-semibold"
        >
          Shaswata Saha
        </a>{" "}
        | © {new Date().getFullYear()} All Rights Reserved
      </p>
    </footer>
  );
};

// Add padding-bottom to main content to prevent footer overlap:
// <main className="pb-16">...</main>
```

### 2. **Implement the Chatbot Component**

Create an intelligent chatbot that talks to the backend:

```jsx
// components/Chatbot.jsx
import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";

const Chatbot = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: userMessage }),
      });

      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.response,
          action: data.action,
          actionResult: data.actionResult,
          suggestions: data.suggestions,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSuggestion = (suggestion) => {
    setInput(suggestion);
  };

  return (
    <>
      {/* Chat Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-20 right-6 bg-blue-600 text-white p-4 rounded-full shadow-lg hover:bg-blue-700 z-50"
      >
        {isOpen ? "✕" : "💬"}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-36 right-6 w-96 h-[500px] bg-white rounded-lg shadow-2xl flex flex-col z-50">
          {/* Header */}
          <div className="bg-blue-600 text-white p-4 rounded-t-lg">
            <h3 className="font-bold">🤖 Voter List Assistant</h3>
            <p className="text-xs opacity-80">Ask me anything about voters!</p>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-gray-500 mt-8">
                <p className="mb-4">Hi! I can help you with:</p>
                <ul className="text-sm space-y-2">
                  <li>🔍 Search voters by name or ID</li>
                  <li>📊 View statistics</li>
                  <li>📄 Check session status</li>
                  <li>⚙️ API engine status</li>
                </ul>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[80%] p-3 rounded-lg ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {msg.role === "user" ? (
                    msg.content
                  ) : (
                    <div className="prose prose-sm">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  )}

                  {/* Suggestions */}
                  {msg.suggestions && msg.suggestions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {msg.suggestions.map((s, j) => (
                        <button
                          key={j}
                          onClick={() => handleSuggestion(s)}
                          className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 p-3 rounded-lg">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                    <div
                      className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.1s" }}
                    />
                    <div
                      className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.2s" }}
                    />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t">
            <div className="flex space-x-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && sendMessage()}
                placeholder="Ask about voters..."
                className="flex-1 border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Chatbot;
```

### 3. **API Engine Status Dashboard (Admin)**

Show the status of all 7 processing engines:

```jsx
// components/ApiEngineStatus.jsx
import { useState, useEffect } from "react";

const ApiEngineStatus = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/api-keys/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error("Failed to fetch API status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, []);

  const resetKeys = async () => {
    try {
      const token = localStorage.getItem("token");
      await fetch("/api/api-keys/reset", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchStatus();
    } catch (err) {
      console.error("Failed to reset keys");
    }
  };

  if (loading) return <div>Loading engine status...</div>;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">🚀 API Engines</h2>
        <button
          onClick={resetKeys}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Reset All
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-blue-50 p-4 rounded-lg text-center">
          <div className="text-3xl font-bold text-blue-600">
            {status.totalEngines}
          </div>
          <div className="text-sm text-gray-600">Total</div>
        </div>
        <div className="bg-green-50 p-4 rounded-lg text-center">
          <div className="text-3xl font-bold text-green-600">
            {status.activeEngines}
          </div>
          <div className="text-sm text-gray-600">Active</div>
        </div>
        <div className="bg-yellow-50 p-4 rounded-lg text-center">
          <div className="text-3xl font-bold text-yellow-600">
            {status.busyEngines}
          </div>
          <div className="text-sm text-gray-600">Busy</div>
        </div>
        <div className="bg-red-50 p-4 rounded-lg text-center">
          <div className="text-3xl font-bold text-red-600">
            {status.exhaustedEngines}
          </div>
          <div className="text-sm text-gray-600">Exhausted</div>
        </div>
      </div>

      {/* Engine Grid */}
      <div className="grid grid-cols-7 gap-2">
        {status.engines?.map((engine) => (
          <div
            key={engine.engineId}
            className={`p-3 rounded-lg text-center border-2 ${
              engine.status === "active"
                ? engine.busy
                  ? "bg-yellow-100 border-yellow-400"
                  : "bg-green-100 border-green-400"
                : "bg-red-100 border-red-400"
            }`}
          >
            <div className="font-bold">#{engine.engineId}</div>
            <div className="text-xs mt-1">
              {engine.status === "active" ? (engine.busy ? "⚡" : "✅") : "❌"}
            </div>
            <div className="text-xs text-gray-600 mt-1">
              {engine.metrics?.engineProcessed || 0} done
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ApiEngineStatus;
```

### 4. **PDF Upload with Progress**

Show real-time progress during PDF processing:

```jsx
// components/PdfUpload.jsx
import { useState } from "react";

const PdfUpload = ({ onComplete }) => {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setProgress({ status: "uploading", message: "Uploading PDF..." });

    try {
      const token = localStorage.getItem("token");
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const data = await res.json();

      if (res.ok) {
        setProgress({
          status: "completed",
          message: `✅ Processed ${data.pages} pages successfully!`,
          data,
        });
        if (onComplete) onComplete(data);
      } else if (res.status === 207) {
        // Partial completion
        setProgress({
          status: "partial",
          message: `⚠️ Processed ${data.processedPages}/${data.pages} pages. Some pages pending.`,
          data,
        });
      } else {
        throw new Error(data.error || "Upload failed");
      }
    } catch (err) {
      setError(err.message);
      setProgress(null);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-xl font-bold mb-4">📄 Upload Voter List PDF</h2>

      <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
        <input
          type="file"
          accept=".pdf"
          onChange={handleUpload}
          disabled={uploading}
          className="hidden"
          id="pdf-upload"
        />
        <label
          htmlFor="pdf-upload"
          className={`cursor-pointer ${uploading ? "opacity-50" : ""}`}
        >
          <div className="text-4xl mb-2">📤</div>
          <p className="text-gray-600">
            {uploading ? "Processing..." : "Click to upload PDF"}
          </p>
          <p className="text-sm text-gray-400 mt-1">
            All 7 engines will process in parallel!
          </p>
        </label>
      </div>

      {progress && (
        <div
          className={`mt-4 p-4 rounded-lg ${
            progress.status === "completed"
              ? "bg-green-100"
              : progress.status === "partial"
              ? "bg-yellow-100"
              : "bg-blue-100"
          }`}
        >
          {progress.message}
        </div>
      )}

      {error && (
        <div className="mt-4 p-4 bg-red-100 text-red-700 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
};

export default PdfUpload;
```

### 5. **Session List with Stop/Resume/Rename** ⭐ NEW

Complete session management with all controls:

```jsx
// components/SessionList.jsx
import { useState, useEffect } from "react";

const SessionList = ({ onSelectSession }) => {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [renameModal, setRenameModal] = useState(null);

  const fetchSessions = async () => {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    // Refresh every 5 seconds for processing sessions
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // 🛑 STOP Processing
  const handleStop = async (id) => {
    setActionLoading(id);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/sessions/${id}/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to stop");
      await fetchSessions();
    } catch (err) {
      alert("Failed to stop: " + err.message);
    }
    setActionLoading(null);
  };

  // ▶️ RESUME Processing
  const handleResume = async (id) => {
    setActionLoading(id);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/sessions/${id}/resume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to resume");
      await fetchSessions();
    } catch (err) {
      alert("Failed to resume: " + err.message);
    }
    setActionLoading(null);
  };

  // ✏️ RENAME Session
  const handleRename = async (id, newName) => {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/sessions/${id}/rename`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error("Failed to rename");
      setRenameModal(null);
      await fetchSessions();
    } catch (err) {
      alert("Failed to rename: " + err.message);
    }
  };

  // 🗑️ DELETE Session
  const handleDelete = async (id) => {
    if (!confirm("Delete this session and all its data?")) return;
    setActionLoading(id);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/sessions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to delete");
      await fetchSessions();
    } catch (err) {
      alert("Failed to delete: " + err.message);
    }
    setActionLoading(null);
  };

  const getStatusBadge = (status) => {
    const styles = {
      processing: "bg-blue-100 text-blue-800 animate-pulse",
      completed: "bg-green-100 text-green-800",
      paused: "bg-yellow-100 text-yellow-800",
      failed: "bg-red-100 text-red-800",
    };
    const icons = {
      processing: "⏳",
      completed: "✅",
      paused: "⏸️",
      failed: "❌",
    };
    return (
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium ${styles[status]}`}
      >
        {icons[status]} {status}
      </span>
    );
  };

  if (loading)
    return <div className="text-center py-8">Loading sessions...</div>;

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      <div className="px-6 py-4 border-b flex justify-between items-center">
        <h2 className="text-xl font-bold">📋 Sessions</h2>
        <button
          onClick={fetchSessions}
          className="text-blue-600 hover:text-blue-800"
        >
          🔄 Refresh
        </button>
      </div>

      <div className="divide-y">
        {sessions.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">
            No sessions yet. Upload a PDF to get started!
          </div>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="px-6 py-4 hover:bg-gray-50">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3
                      className="font-medium cursor-pointer hover:text-blue-600"
                      onClick={() => onSelectSession?.(session)}
                    >
                      {session.original_filename}
                    </h3>
                    {getStatusBadge(session.status)}
                    <button
                      onClick={() => setRenameModal(session)}
                      className="text-gray-400 hover:text-gray-600"
                      title="Rename"
                    >
                      ✏️
                    </button>
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    {session.processed_pages}/{session.total_pages} pages •{" "}
                    {session.voter_count || 0} voters •{" "}
                    {new Date(session.created_at).toLocaleDateString()}
                  </div>

                  {/* Progress bar for processing sessions */}
                  {session.status === "processing" &&
                    session.total_pages > 0 && (
                      <div className="mt-2">
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div
                            className="bg-blue-500 h-2 rounded-full transition-all"
                            style={{
                              width: `${
                                (session.processed_pages /
                                  session.total_pages) *
                                100
                              }%`,
                            }}
                          />
                        </div>
                        <p className="text-xs text-gray-400 mt-1">
                          ⏰ ~
                          {(session.total_pages - session.processed_pages) * 30}s
                          remaining
                        </p>
                      </div>
                    )}
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2 ml-4">
                  {session.status === "processing" && (
                    <button
                      onClick={() => handleStop(session.id)}
                      disabled={actionLoading === session.id}
                      className="px-3 py-1 bg-yellow-500 text-white rounded hover:bg-yellow-600 
                               disabled:opacity-50 text-sm font-medium"
                    >
                      🛑 Stop
                    </button>
                  )}

                  {(session.status === "paused" ||
                    session.status === "failed") && (
                    <button
                      onClick={() => handleResume(session.id)}
                      disabled={actionLoading === session.id}
                      className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 
                               disabled:opacity-50 text-sm font-medium"
                    >
                      ▶️ Resume
                    </button>
                  )}

                  <button
                    onClick={() => handleDelete(session.id)}
                    disabled={actionLoading === session.id}
                    className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 
                             disabled:opacity-50 text-sm"
                    title="Delete"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Rename Modal */}
      {renameModal && (
        <RenameModal
          session={renameModal}
          onClose={() => setRenameModal(null)}
          onRename={handleRename}
        />
      )}
    </div>
  );
};

// Rename Modal Component
const RenameModal = ({ session, onClose, onRename }) => {
  const [name, setName] = useState(session.original_filename);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (name.trim()) {
      onRename(session.id, name.trim());
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <h3 className="text-lg font-bold mb-4">✏️ Rename Session</h3>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="Enter new name"
            autoFocus
          />
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 border rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SessionList;
```

### 5. **Update API Base URL**

Make sure your API calls point to the correct backend:

```js
// lib/api.js or similar
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export const api = {
  chat: (message) =>
    fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify({ message }),
    }),

  getEngineStatus: () =>
    fetch(`${API_BASE}/api-keys/status`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    }),

  // ... other API calls
};
```

### 7. **Install Required Dependencies**

```bash
npm install react-markdown
```

---

## 🔌 API Endpoints Summary

| Endpoint               | Method | Auth  | Description                      |
| ---------------------- | ------ | ----- | -------------------------------- |
| `/auth/login`          | POST   | No    | Login and get JWT token          |
| `/sessions`            | GET    | Yes   | List all sessions                |
| `/sessions`            | POST   | Admin | Upload PDF and start processing  |
| `/sessions/:id`        | GET    | Yes   | Get session details              |
| `/sessions/:id/status` | GET    | Yes   | Get processing status            |
| `/sessions/:id/stop`   | POST   | Admin | **⭐ NEW** Stop/pause processing |
| `/sessions/:id/resume` | POST   | Admin | Resume paused session            |
| `/sessions/:id/rename` | PATCH  | Admin | **⭐ NEW** Rename session        |
| `/sessions/:id`        | DELETE | Admin | Delete session                   |
| `/sessions/:id/voters` | GET    | Yes   | Get voters for session           |
| `/voters/search`       | GET    | Yes   | Search all voters                |
| `/api-keys/status`     | GET    | Admin | API engine status with metrics   |
| `/api-keys/reset`      | POST   | Admin | Reset all API engines            |
| `/chat`                | POST   | Yes   | NLP chatbot queries              |
| `/chat/actions`        | GET    | Yes   | Get available chat actions       |
| `/system/info`         | GET    | Yes   | System info with author credits  |
| `/api-keys/reset`      | POST   | Admin | Reset all engines                |

---

## 🎨 Design Notes

1. **Footer**: Always visible, fixed at bottom, with creator credits
2. **Chatbot**: Floating button in bottom-right, opens chat window
3. **Engine Status**: Visual grid showing 7 engines with colors
4. **Markdown Tables**: Chat responses use markdown tables for data
5. **Real-time Updates**: Engine status refreshes every 5 seconds

---

## ✅ Checklist

- [ ] Add sticky footer with credits
- [ ] Implement chatbot component
- [ ] Add API engine status dashboard
- [ ] Add session list with Stop/Resume/Rename buttons ⭐ NEW
- [ ] Update PDF upload with progress
- [ ] Install react-markdown
- [ ] Update API base URL if needed
- [ ] Test stop/resume functionality
- [ ] Test session rename
- [ ] Test chatbot with various queries
- [ ] Test PDF upload with 40+ page PDFs

---

**© 2026 Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app)
