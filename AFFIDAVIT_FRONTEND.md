# Affidavit OCR Scanner — Frontend Implementation Guide

**For: Voter List Management System Frontend**
**Feature: Affidavit PDF OCR → Database → DOCX Export**
**Created by: Shaswata Saha | ssaha.vercel.app**

---

## 🎯 Summary

A brand-new **Affidavit Scanner** feature that:

1. Uploads Indian election affidavit/nomination PDFs (Form 2B, Form 26, etc.)
2. OCR-processes every page via Gemini AI (parallel engines)
3. Extracts ALL data — text fields, tables, criminal records, assets, liabilities
4. Stores extracted data dynamically in PostgreSQL
5. Exports a **styled Word DOCX** with perfect table borders and formatting
6. Includes a revamped **Navbar with overflow "More" dropdown** and a **beautiful homepage**

---

## 📡 API Endpoints

All routes are prefixed with `/affidavits` and require `Authorization: Bearer <token>` with an admin account.

| Method   | Endpoint                               | Description                                              |
| -------- | -------------------------------------- | -------------------------------------------------------- |
| `POST`   | `/affidavits/upload`                   | Upload & OCR-process an affidavit PDF                    |
| `GET`    | `/affidavits/sessions`                 | List all affidavit sessions                              |
| `GET`    | `/affidavits/sessions/:id`             | Full session details (entries, tables, pages)            |
| `GET`    | `/affidavits/sessions/:id/status`      | Polling endpoint for processing progress                 |
| `GET`    | `/affidavits/sessions/:id/entries`     | Get all extracted fields (filterable by category)        |
| `GET`    | `/affidavits/sessions/:id/export/docx` | Download styled `.docx` file                             |
| `DELETE` | `/affidavits/sessions/:id`             | Delete a session and its storage                         |
| `PATCH`  | `/affidavits/sessions/:id/rename`      | Rename session (`{ "name": "..." }`)                     |
| `POST`   | `/affidavits/sessions/:id/stop`        | Stop an active processing session                        |
| `GET`    | `/affidavits/search`                   | Search across affidavits by candidate/party/constituency |

---

## 🧭 1. Navbar with Overflow "More" Button

### Design Philosophy

The navbar should be **sleek, glassmorphic, and responsive**. When items overflow the available width, excess items collapse into a "More ▾" dropdown.

### Implementation

```jsx
// components/Navbar.jsx
import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";

const NAV_ITEMS = [
  { label: "Home", path: "/", icon: "🏠" },
  { label: "Upload PDF", path: "/upload", icon: "📤" },
  { label: "Sessions", path: "/sessions", icon: "📁" },
  { label: "Voter Search", path: "/search", icon: "🔍" },
  { label: "Election Results", path: "/election-results", icon: "📊" },
  { label: "Affidavit Scanner", path: "/affidavits", icon: "📋" },
  { label: "AI Agent", path: "/agent", icon: "🤖" },
  { label: "Statistics", path: "/statistics", icon: "📈" },
  { label: "Settings", path: "/settings", icon: "⚙️" },
];

export default function Navbar() {
  const location = useLocation();
  const navRef = useRef(null);
  const itemRefs = useRef([]);
  const [visibleCount, setVisibleCount] = useState(NAV_ITEMS.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const moreRef = useRef(null);

  // Calculate how many items fit
  useEffect(() => {
    const calculateOverflow = () => {
      if (!navRef.current) return;
      const navWidth = navRef.current.offsetWidth;
      const moreButtonWidth = 120; // Reserve space for "More" button
      let totalWidth = 0;
      let count = 0;

      for (let i = 0; i < itemRefs.current.length; i++) {
        const el = itemRefs.current[i];
        if (!el) continue;
        totalWidth += el.offsetWidth + 8; // 8px gap
        if (totalWidth + moreButtonWidth > navWidth) break;
        count++;
      }

      setVisibleCount(count < NAV_ITEMS.length ? count : NAV_ITEMS.length);
    };

    calculateOverflow();
    window.addEventListener("resize", calculateOverflow);
    return () => window.removeEventListener("resize", calculateOverflow);
  }, []);

  // Close "More" dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const visibleItems = NAV_ITEMS.slice(0, visibleCount);
  const overflowItems = NAV_ITEMS.slice(visibleCount);

  return (
    <>
      {/* Desktop Navbar */}
      <nav className="sticky top-0 z-50 backdrop-blur-xl bg-gradient-to-r from-slate-900/90 via-blue-900/80 to-indigo-900/90 border-b border-white/10 shadow-2xl">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center h-16 justify-between">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-2 shrink-0">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-400 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
                <span className="text-white font-bold text-lg">V</span>
              </div>
              <span className="text-white font-bold text-lg hidden sm:block tracking-tight">
                VoterDB
              </span>
            </Link>

            {/* Nav Links */}
            <div
              ref={navRef}
              className="hidden md:flex items-center gap-1 flex-1 justify-center overflow-hidden"
            >
              {visibleItems.map((item, i) => {
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    ref={(el) => (itemRefs.current[i] = el)}
                    className={`relative px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 whitespace-nowrap
                      ${
                        isActive
                          ? "text-white bg-white/15 shadow-inner"
                          : "text-blue-100/70 hover:text-white hover:bg-white/10"
                      }`}
                  >
                    <span className="mr-1.5">{item.icon}</span>
                    {item.label}
                    {isActive && (
                      <motion.div
                        layoutId="activeTab"
                        className="absolute bottom-0 left-2 right-2 h-0.5 bg-gradient-to-r from-blue-400 to-indigo-400 rounded-full"
                      />
                    )}
                  </Link>
                );
              })}

              {/* More dropdown */}
              {overflowItems.length > 0 && (
                <div ref={moreRef} className="relative">
                  <button
                    onClick={() => setMoreOpen(!moreOpen)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-1
                      ${
                        moreOpen
                          ? "text-white bg-white/15"
                          : "text-blue-100/70 hover:text-white hover:bg-white/10"
                      }`}
                  >
                    More
                    <svg
                      className={`w-3.5 h-3.5 transition-transform ${moreOpen ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>

                  <AnimatePresence>
                    {moreOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                        className="absolute right-0 mt-2 w-56 rounded-xl bg-slate-800/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden"
                      >
                        {overflowItems.map((item) => {
                          const isActive = location.pathname === item.path;
                          return (
                            <Link
                              key={item.path}
                              to={item.path}
                              onClick={() => setMoreOpen(false)}
                              className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors
                                ${
                                  isActive
                                    ? "bg-blue-600/30 text-white"
                                    : "text-blue-100/70 hover:bg-white/10 hover:text-white"
                                }`}
                            >
                              <span className="text-lg">{item.icon}</span>
                              {item.label}
                            </Link>
                          );
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>

            {/* User Menu + Mobile Toggle */}
            <div className="flex items-center gap-3">
              {/* Profile avatar */}
              <button className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center text-white text-xs font-bold shadow-lg">
                A
              </button>

              {/* Mobile menu button */}
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="md:hidden p-2 rounded-lg text-blue-100/70 hover:text-white hover:bg-white/10"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {mobileOpen ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  )}
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="md:hidden border-t border-white/10 overflow-hidden"
            >
              <div className="px-4 py-3 space-y-1">
                {NAV_ITEMS.map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      onClick={() => setMobileOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                        ${
                          isActive
                            ? "bg-white/15 text-white"
                            : "text-blue-100/60 hover:bg-white/10 hover:text-white"
                        }`}
                    >
                      <span>{item.icon}</span>
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>
    </>
  );
}
```

### Tailwind Additions (tailwind.config.js)

Ensure these are in your `tailwind.config.js`:

```js
module.exports = {
  theme: {
    extend: {
      backdropBlur: {
        xl: "24px",
      },
    },
  },
};
```

---

## 🏠 2. Homepage with Hero Section & Photos

### Design

A beautiful landing page with:

- Gradient hero with animated particles
- Photo cards for team/specific persons (from `/public` folder)
- Feature cards with glassmorphism
- Statistics pulled from the API

```jsx
// pages/Home.jsx
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import axios from "axios";

const FEATURES = [
  {
    icon: "📄",
    title: "Voter List OCR",
    description: "Upload voter list PDFs and extract data with AI-powered OCR",
    path: "/upload",
    gradient: "from-blue-500 to-cyan-400",
  },
  {
    icon: "📊",
    title: "Election Results",
    description: "Process Form 20 election result sheets with booth-wise data",
    path: "/election-results",
    gradient: "from-purple-500 to-pink-400",
  },
  {
    icon: "📋",
    title: "Affidavit Scanner",
    description: "OCR nomination papers & affidavits, export as Word documents",
    path: "/affidavits",
    gradient: "from-emerald-500 to-teal-400",
  },
  {
    icon: "🤖",
    title: "AI Agent",
    description: "Query the voter database using natural language",
    path: "/agent",
    gradient: "from-orange-500 to-amber-400",
  },
  {
    icon: "🔍",
    title: "Smart Search",
    description: "Find voters by name, ID, assembly, religion, and more",
    path: "/search",
    gradient: "from-rose-500 to-red-400",
  },
  {
    icon: "📈",
    title: "Analytics",
    description: "View demographics, religion stats, and age distributions",
    path: "/statistics",
    gradient: "from-indigo-500 to-violet-400",
  },
];

// Person photos — add actual images to /public/photos/ folder
const TEAM_PHOTOS = [
  { name: "Person 1", role: "Title Here", photo: "/photos/person1.jpg" },
  { name: "Person 2", role: "Title Here", photo: "/photos/person2.jpg" },
  { name: "Person 3", role: "Title Here", photo: "/photos/person3.jpg" },
  { name: "Person 4", role: "Title Here", photo: "/photos/person4.jpg" },
];

export default function Home() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const token = localStorage.getItem("token");
        if (!token) return;

        const [votersRes, sessionsRes] = await Promise.all([
          axios
            .get("/agent/quick/total-voters", {
              headers: { Authorization: `Bearer ${token}` },
            })
            .catch(() => null),
          axios
            .get("/agent/quick/total-sessions", {
              headers: { Authorization: `Bearer ${token}` },
            })
            .catch(() => null),
        ]);

        setStats({
          totalVoters: votersRes?.data?.data?.[0]?.total || 0,
          totalSessions: sessionsRes?.data?.data?.[0]?.total || 0,
        });
      } catch {
        // Stats are optional
      }
    };
    fetchStats();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Animated gradient orbs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-500/20 rounded-full blur-3xl animate-pulse" />
          <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-500/20 rounded-full blur-3xl animate-pulse delay-1000" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-500/10 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-7xl mx-auto px-4 pt-20 pb-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-400/20 text-blue-300 text-sm mb-6">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              AI-Powered Election Data Platform
            </div>

            <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 tracking-tight">
              Voter Database
              <br />
              <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-indigo-400 text-transparent bg-clip-text">
                Management System
              </span>
            </h1>

            <p className="text-xl text-blue-200/60 max-w-2xl mx-auto mb-10">
              Upload voter lists, election results, and affidavits. Our AI
              extracts, organizes, and makes your data searchable in seconds.
            </p>

            <div className="flex flex-wrap justify-center gap-4 mb-16">
              <Link
                to="/upload"
                className="px-8 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-105 transition-all duration-200"
              >
                Upload PDF →
              </Link>
              <Link
                to="/affidavits"
                className="px-8 py-3 rounded-xl bg-white/10 backdrop-blur border border-white/20 text-white font-semibold hover:bg-white/20 hover:scale-105 transition-all duration-200"
              >
                📋 Scan Affidavit
              </Link>
            </div>

            {/* Live Stats */}
            {stats && (
              <div className="flex justify-center gap-8">
                <div className="text-center">
                  <div className="text-3xl font-bold text-white">
                    {stats.totalVoters.toLocaleString()}
                  </div>
                  <div className="text-sm text-blue-300/50">
                    Voters Processed
                  </div>
                </div>
                <div className="w-px bg-white/10" />
                <div className="text-center">
                  <div className="text-3xl font-bold text-white">
                    {stats.totalSessions}
                  </div>
                  <div className="text-sm text-blue-300/50">PDF Sessions</div>
                </div>
              </div>
            )}
          </motion.div>
        </div>
      </section>

      {/* Feature Cards */}
      <section className="max-w-7xl mx-auto px-4 py-16">
        <h2 className="text-3xl font-bold text-white text-center mb-12">
          Everything You Need
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <Link
                to={feature.path}
                className="group block p-6 rounded-2xl bg-white/5 backdrop-blur border border-white/10 hover:bg-white/10 hover:border-white/20 hover:scale-[1.02] transition-all duration-300"
              >
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center text-2xl mb-4 shadow-lg group-hover:scale-110 transition-transform`}
                >
                  {feature.icon}
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">
                  {feature.title}
                </h3>
                <p className="text-sm text-blue-200/50 leading-relaxed">
                  {feature.description}
                </p>
              </Link>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Team / People Photos */}
      <section className="max-w-7xl mx-auto px-4 py-16">
        <h2 className="text-3xl font-bold text-white text-center mb-4">
          Our Team
        </h2>
        <p className="text-blue-200/50 text-center mb-12">
          {/* Update with actual description */}
          The people behind this platform
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {TEAM_PHOTOS.map((person, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.15 }}
              className="group text-center"
            >
              <div className="relative mb-4 overflow-hidden rounded-2xl aspect-square bg-gradient-to-br from-slate-700 to-slate-800 border border-white/10">
                <img
                  src={person.photo}
                  alt={person.name}
                  className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                  onError={(e) => {
                    // Placeholder if image doesn't exist yet
                    e.target.style.display = "none";
                    e.target.nextSibling.style.display = "flex";
                  }}
                />
                <div className="absolute inset-0 items-center justify-center text-4xl bg-gradient-to-br from-blue-600/30 to-indigo-600/30 hidden">
                  👤
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <h3 className="text-white font-semibold">{person.name}</h3>
              <p className="text-sm text-blue-300/50">{person.role}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 text-center">
        <p className="text-sm text-blue-200/30">
          Created by{" "}
          <a
            href="https://ssaha.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400/60 hover:text-blue-300 transition-colors"
          >
            Shaswata Saha
          </a>{" "}
          | © {new Date().getFullYear()} All Rights Reserved
        </p>
      </footer>
    </div>
  );
}
```

### Photo Setup

Create a `/public/photos/` folder and add person images:

```
public/
  photos/
    person1.jpg
    person2.jpg
    person3.jpg
    person4.jpg
```

Update the `TEAM_PHOTOS` array with real names, roles, and file paths.

---

## 📋 3. Affidavit Scanner Page

### 3.1 Upload & Processing Page

```jsx
// pages/AffidavitScanner.jsx
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import axios from "axios";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_URL || "";

function getAuthHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

export default function AffidavitScanner() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeUpload, setActiveUpload] = useState(null); // { sessionId, progress }
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions();
  }, []);

  // Poll active upload progress
  useEffect(() => {
    if (!activeUpload) return;
    const interval = setInterval(async () => {
      try {
        const { data } = await axios.get(
          `${API_BASE}/affidavits/sessions/${activeUpload.sessionId}/status`,
          { headers: getAuthHeaders() },
        );
        setActiveUpload((prev) => ({ ...prev, ...data }));
        if (data.status !== "processing") {
          clearInterval(interval);
          fetchSessions();
        }
      } catch {
        // continue polling
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [activeUpload?.sessionId]);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const { data } = await axios.get(`${API_BASE}/affidavits/sessions`, {
        headers: getAuthHeaders(),
      });
      setSessions(data.sessions);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await axios.post(`${API_BASE}/affidavits/upload`, fd, {
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "multipart/form-data",
        },
      });
      setActiveUpload({
        sessionId: data.sessionId,
        totalPages: data.totalPages,
        processedPages: 0,
        status: "processing",
      });
      setFile(null);
    } catch (err) {
      setError(err.response?.data?.error || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this affidavit session?")) return;
    try {
      await axios.delete(`${API_BASE}/affidavits/sessions/${id}`, {
        headers: getAuthHeaders(),
      });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || "Delete failed");
    }
  };

  const handleStop = async (id) => {
    try {
      await axios.post(
        `${API_BASE}/affidavits/sessions/${id}/stop`,
        {},
        { headers: getAuthHeaders() },
      );
      fetchSessions();
    } catch (err) {
      setError(err.response?.data?.error || "Stop failed");
    }
  };

  const handleExportDocx = async (id, candidateName) => {
    try {
      const response = await axios.get(
        `${API_BASE}/affidavits/sessions/${id}/export/docx`,
        {
          headers: getAuthHeaders(),
          responseType: "blob",
        },
      );
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.download = candidateName
        ? `Affidavit_${candidateName.replace(/[^a-zA-Z0-9]/g, "_")}.docx`
        : `Affidavit_${id.slice(0, 8)}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError("Export failed: " + (err.response?.data?.error || err.message));
    }
  };

  const filteredSessions = sessions.filter((s) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (s.candidate_name || "").toLowerCase().includes(q) ||
      (s.party || "").toLowerCase().includes(q) ||
      (s.constituency || "").toLowerCase().includes(q) ||
      (s.original_filename || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white flex items-center gap-3">
            <span className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-2xl shadow-lg shadow-emerald-500/20">
              📋
            </span>
            Affidavit Scanner
          </h1>
          <p className="text-blue-200/50 mt-2 ml-15">
            Upload nomination papers & affidavits. AI extracts all data and
            exports to Word.
          </p>
        </motion.div>

        {/* Upload Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8 p-6 rounded-2xl bg-white/5 backdrop-blur border border-white/10"
        >
          <h2 className="text-lg font-semibold text-white mb-4">
            Upload Affidavit PDF
          </h2>

          <div className="flex flex-col sm:flex-row gap-4">
            {/* File drop zone */}
            <label
              className={`flex-1 flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-8 cursor-pointer transition-all duration-200
                ${
                  file
                    ? "border-emerald-400/50 bg-emerald-500/10"
                    : "border-white/20 hover:border-blue-400/50 hover:bg-white/5"
                }`}
            >
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setFile(e.target.files[0])}
                className="hidden"
              />
              {file ? (
                <>
                  <span className="text-3xl mb-2">✅</span>
                  <span className="text-emerald-300 font-medium">
                    {file.name}
                  </span>
                  <span className="text-sm text-emerald-400/50 mt-1">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </>
              ) : (
                <>
                  <span className="text-4xl mb-3 opacity-50">📄</span>
                  <span className="text-blue-200/50 text-sm">
                    Drop PDF here or click to browse
                  </span>
                </>
              )}
            </label>

            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className={`px-8 py-4 rounded-xl font-semibold transition-all duration-200 self-end sm:self-center
                ${
                  file && !uploading
                    ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40 hover:scale-105"
                    : "bg-white/10 text-white/30 cursor-not-allowed"
                }`}
            >
              {uploading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Processing...
                </span>
              ) : (
                "🔬 Scan & Extract"
              )}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-400/20 text-red-300 text-sm">
              {error}
            </div>
          )}
        </motion.div>

        {/* Active processing card */}
        <AnimatePresence>
          {activeUpload && activeUpload.status === "processing" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-8 p-6 rounded-2xl bg-gradient-to-r from-blue-900/40 to-indigo-900/40 border border-blue-400/20"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-semibold flex items-center gap-2">
                  <svg
                    className="animate-spin w-5 h-5 text-blue-400"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Processing Affidavit...
                </h3>
                <button
                  onClick={() => handleStop(activeUpload.sessionId)}
                  className="px-4 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 text-sm transition-colors"
                >
                  ⏹ Stop
                </button>
              </div>

              {/* Progress bar */}
              <div className="w-full bg-white/10 rounded-full h-3 mb-2">
                <div
                  className="bg-gradient-to-r from-blue-400 to-indigo-500 h-3 rounded-full transition-all duration-500"
                  style={{
                    width: `${activeUpload.totalPages ? (activeUpload.processedPages / activeUpload.totalPages) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-sm text-blue-200/50">
                <span>
                  Page {activeUpload.processedPages || 0} of{" "}
                  {activeUpload.totalPages || "?"}
                </span>
                <span>{activeUpload.fieldCount || 0} fields extracted</span>
              </div>
              {activeUpload.candidateName && (
                <div className="mt-2 text-sm text-emerald-300">
                  Candidate detected:{" "}
                  <strong>{activeUpload.candidateName}</strong>
                  {activeUpload.party && ` (${activeUpload.party})`}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search */}
        <div className="mb-6 flex items-center gap-4">
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-blue-300/30"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Search by candidate, party, constituency..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-blue-300/30 focus:outline-none focus:border-blue-400/50 focus:ring-1 focus:ring-blue-400/30 transition-all"
            />
          </div>
          <button
            onClick={fetchSessions}
            className="px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-blue-200/50 hover:text-white hover:bg-white/10 transition-all"
          >
            ↻ Refresh
          </button>
        </div>

        {/* Sessions Grid */}
        {loading ? (
          <div className="text-center py-20 text-blue-200/30">
            Loading sessions...
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="text-center py-20">
            <span className="text-5xl opacity-30 block mb-4">📋</span>
            <p className="text-blue-200/30">
              No affidavit sessions yet. Upload one above!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSessions.map((session, i) => (
              <motion.div
                key={session.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="group p-5 rounded-2xl bg-white/5 backdrop-blur border border-white/10 hover:border-white/20 hover:bg-white/[0.08] transition-all duration-300"
              >
                {/* Status badge */}
                <div className="flex items-center justify-between mb-3">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-medium
                      ${
                        session.status === "completed"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : session.status === "processing"
                            ? "bg-blue-500/20 text-blue-300"
                            : session.status === "failed"
                              ? "bg-red-500/20 text-red-300"
                              : "bg-yellow-500/20 text-yellow-300"
                      }`}
                  >
                    {session.status === "processing" && "⏳ "}
                    {session.status === "completed" && "✅ "}
                    {session.status === "failed" && "❌ "}
                    {session.status === "paused" && "⏸ "}
                    {session.status}
                  </span>
                  <span className="text-xs text-blue-200/30">
                    {new Date(session.created_at).toLocaleDateString()}
                  </span>
                </div>

                {/* Candidate info */}
                <h3 className="text-white font-semibold mb-1 truncate">
                  {session.candidate_name ||
                    session.original_filename ||
                    "Untitled"}
                </h3>
                {session.party && (
                  <p className="text-sm text-blue-200/50 mb-1 truncate">
                    🏛 {session.party}
                  </p>
                )}
                {session.constituency && (
                  <p className="text-sm text-blue-200/40 mb-3 truncate">
                    📍 {session.constituency}
                  </p>
                )}

                {/* Metrics */}
                <div className="flex gap-3 mb-4 text-xs text-blue-200/30">
                  <span>📄 {session.total_pages} pages</span>
                  <span>📝 {session.field_count || 0} fields</span>
                  <span>📊 {session.table_count || 0} tables</span>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <Link
                    to={`/affidavits/${session.id}`}
                    className="flex-1 text-center px-3 py-2 rounded-lg bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 text-sm font-medium transition-colors"
                  >
                    View Details
                  </Link>
                  {session.status === "completed" && (
                    <button
                      onClick={() =>
                        handleExportDocx(session.id, session.candidate_name)
                      }
                      className="px-3 py-2 rounded-lg bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 text-sm font-medium transition-colors"
                      title="Export DOCX"
                    >
                      📥 DOCX
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(session.id)}
                    className="px-3 py-2 rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20 text-sm transition-colors"
                    title="Delete"
                  >
                    🗑
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

### 3.2 Affidavit Detail Page

```jsx
// pages/AffidavitDetail.jsx
import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import axios from "axios";

const API_BASE = import.meta.env.VITE_API_URL || "";

function getAuthHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

// Category display names
const CATEGORY_LABELS = {
  candidate_info: { label: "Candidate Information", icon: "👤", color: "blue" },
  proposer_info: { label: "Proposer Information", icon: "✍️", color: "indigo" },
  criminal_record: { label: "Criminal Record", icon: "⚖️", color: "red" },
  office_of_profit: { label: "Office of Profit", icon: "🏛", color: "amber" },
  insolvency: { label: "Insolvency", icon: "💰", color: "orange" },
  foreign_allegiance: {
    label: "Foreign Allegiance",
    icon: "🌍",
    color: "purple",
  },
  disqualification: { label: "Disqualification", icon: "🚫", color: "rose" },
  dismissal_corruption: {
    label: "Dismissal for Corruption",
    icon: "⛔",
    color: "red",
  },
  government_contracts: {
    label: "Government Contracts",
    icon: "📜",
    color: "teal",
  },
  assets_movable: { label: "Movable Assets", icon: "🚗", color: "emerald" },
  assets_immovable: { label: "Immovable Assets", icon: "🏠", color: "green" },
  liabilities: { label: "Liabilities", icon: "💳", color: "yellow" },
  general: { label: "General Information", icon: "📋", color: "slate" },
};

export default function AffidavitDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [error, setError] = useState("");

  useEffect(() => {
    fetchDetail();
  }, [id]);

  const fetchDetail = async () => {
    try {
      setLoading(true);
      const { data: result } = await axios.get(
        `${API_BASE}/affidavits/sessions/${id}`,
        { headers: getAuthHeaders() },
      );
      setData(result);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to load session");
    } finally {
      setLoading(false);
    }
  };

  const handleExportDocx = async () => {
    try {
      const response = await axios.get(
        `${API_BASE}/affidavits/sessions/${id}/export/docx`,
        { headers: getAuthHeaders(), responseType: "blob" },
      );
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.download = data?.session?.candidate_name
        ? `Affidavit_${data.session.candidate_name.replace(/[^a-zA-Z0-9]/g, "_")}.docx`
        : `Affidavit_${id.slice(0, 8)}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError("Export failed");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 flex items-center justify-center">
        <div className="text-blue-200/30">Loading...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 flex items-center justify-center">
        <div className="text-red-300">{error || "Session not found"}</div>
      </div>
    );
  }

  const { session, entries, entriesByCategory, tables } = data;

  const tabs = [
    { key: "overview", label: "Overview", icon: "📋" },
    { key: "fields", label: "Extracted Fields", icon: "📝" },
    { key: "tables", label: "Tables", icon: "📊" },
    { key: "raw", label: "Raw OCR", icon: "📃" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-blue-200/30 mb-6">
          <Link
            to="/affidavits"
            className="hover:text-blue-300 transition-colors"
          >
            Affidavit Scanner
          </Link>
          <span>/</span>
          <span className="text-blue-200/60">
            {session.candidate_name || session.original_filename}
          </span>
        </div>

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-white">
              {session.candidate_name ||
                session.original_filename ||
                "Affidavit"}
            </h1>
            <div className="flex flex-wrap gap-3 mt-2">
              {session.party && (
                <span className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-300 text-xs border border-blue-400/20">
                  🏛 {session.party}
                </span>
              )}
              {session.constituency && (
                <span className="px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-300 text-xs border border-indigo-400/20">
                  📍 {session.constituency}
                </span>
              )}
              {session.state && (
                <span className="px-3 py-1 rounded-full bg-purple-500/10 text-purple-300 text-xs border border-purple-400/20">
                  🗺 {session.state}
                </span>
              )}
              <span
                className={`px-3 py-1 rounded-full text-xs border
                  ${
                    session.status === "completed"
                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-400/20"
                      : "bg-yellow-500/10 text-yellow-300 border-yellow-400/20"
                  }`}
              >
                {session.status}
              </span>
            </div>
          </div>

          <button
            onClick={handleExportDocx}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-semibold shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 hover:scale-105 transition-all duration-200 flex items-center gap-2"
          >
            📥 Export as DOCX
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-8 p-1 rounded-xl bg-white/5 border border-white/10 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 min-w-fit px-4 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap
                ${
                  activeTab === tab.key
                    ? "bg-white/15 text-white shadow-inner"
                    : "text-blue-200/50 hover:text-white hover:bg-white/5"
                }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Tab: Overview */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
              <div className="text-2xl font-bold text-white">
                {session.total_pages}
              </div>
              <div className="text-xs text-blue-200/40">Pages</div>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
              <div className="text-2xl font-bold text-white">
                {entries?.length || 0}
              </div>
              <div className="text-xs text-blue-200/40">Fields Extracted</div>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
              <div className="text-2xl font-bold text-white">
                {tables?.length || 0}
              </div>
              <div className="text-xs text-blue-200/40">Tables Found</div>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
              <div className="text-2xl font-bold text-white">
                {Object.keys(entriesByCategory || {}).length}
              </div>
              <div className="text-xs text-blue-200/40">Categories</div>
            </div>
          </div>
        )}

        {/* Tab: Extracted Fields by Category */}
        {activeTab === "fields" && (
          <div className="space-y-6">
            {Object.entries(entriesByCategory || {}).map(
              ([category, fields]) => {
                const meta =
                  CATEGORY_LABELS[category] || CATEGORY_LABELS.general;
                return (
                  <motion.div
                    key={category}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-5 rounded-2xl bg-white/5 border border-white/10"
                  >
                    <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                      <span>{meta.icon}</span>
                      {meta.label}
                      <span className="text-xs text-blue-200/30 font-normal">
                        ({fields.length} fields)
                      </span>
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {fields.map((field) => (
                        <div
                          key={field.id}
                          className="flex flex-col p-3 rounded-lg bg-white/5 border border-white/5"
                        >
                          <span className="text-xs text-blue-200/40 mb-1">
                            {field.field_name
                              .replace(/([A-Z])/g, " $1")
                              .replace(/_/g, " ")
                              .replace(/^./, (c) => c.toUpperCase())
                              .trim()}
                          </span>
                          <span className="text-white text-sm font-medium">
                            {field.field_value || "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                );
              },
            )}
          </div>
        )}

        {/* Tab: Tables */}
        {activeTab === "tables" && (
          <div className="space-y-6">
            {(tables || []).length === 0 ? (
              <div className="text-center py-16 text-blue-200/30">
                No tables found in this document.
              </div>
            ) : (
              tables.map((table, idx) => {
                const headers =
                  typeof table.headers === "string"
                    ? JSON.parse(table.headers)
                    : table.headers || [];
                const rows =
                  typeof table.rows_data === "string"
                    ? JSON.parse(table.rows_data)
                    : table.rows_data || [];

                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="p-5 rounded-2xl bg-white/5 border border-white/10"
                  >
                    <h3 className="text-white font-semibold mb-4">
                      {table.table_title || `Table ${idx + 1}`}
                      <span className="text-xs text-blue-200/30 ml-2">
                        (Page {table.page_number})
                      </span>
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        {headers.length > 0 && (
                          <thead>
                            <tr>
                              {headers.map((h, hi) => (
                                <th
                                  key={hi}
                                  className="px-3 py-2 text-left text-xs font-semibold text-blue-200/60 bg-white/5 border border-white/10"
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                        )}
                        <tbody>
                          {rows.map((row, ri) => (
                            <tr key={ri}>
                              {(Array.isArray(row) ? row : []).map(
                                (cell, ci) => (
                                  <td
                                    key={ci}
                                    className="px-3 py-2 text-sm text-white/80 border border-white/10"
                                  >
                                    {cell || "—"}
                                  </td>
                                ),
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>
        )}

        {/* Tab: Raw OCR */}
        {activeTab === "raw" && (
          <div className="space-y-4">
            {(data.pages || []).map((page) => (
              <motion.div
                key={page.page_number}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="p-5 rounded-2xl bg-white/5 border border-white/10"
              >
                <h3 className="text-white font-semibold mb-3">
                  Page {page.page_number}
                </h3>
                <pre className="text-xs text-blue-200/50 whitespace-pre-wrap font-mono max-h-[400px] overflow-y-auto bg-black/20 rounded-lg p-4">
                  {page.raw_text || "(no text)"}
                </pre>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 🎨 4. Router Setup

Add these routes to your React Router configuration:

```jsx
// App.jsx or routes.jsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar";
import Home from "./pages/Home";
import AffidavitScanner from "./pages/AffidavitScanner";
import AffidavitDetail from "./pages/AffidavitDetail";
// ... other imports

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <main className="pb-16">
        <Routes>
          <Route path="/" element={<Home />} />
          {/* ... existing routes ... */}
          <Route path="/affidavits" element={<AffidavitScanner />} />
          <Route path="/affidavits/:id" element={<AffidavitDetail />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
```

---

## 📦 5. Required Frontend Dependencies

```bash
npm install framer-motion react-router-dom axios
```

---

## 🗄️ 6. Database Schema (Auto-created)

The backend automatically creates these tables on startup via `initDb.js`:

### `affidavit_sessions`

| Column              | Type        | Description                        |
| ------------------- | ----------- | ---------------------------------- |
| `id`                | UUID (PK)   | Session identifier                 |
| `original_filename` | TEXT        | Uploaded PDF name                  |
| `candidate_name`    | TEXT        | Extracted candidate name           |
| `party`             | TEXT        | Political party                    |
| `constituency`      | TEXT        | Assembly constituency              |
| `state`             | TEXT        | State name                         |
| `status`            | TEXT        | processing/completed/failed/paused |
| `total_pages`       | INT         | Total PDF pages                    |
| `processed_pages`   | INT         | OCR-completed pages                |
| `created_at`        | TIMESTAMPTZ | Created timestamp                  |

### `affidavit_pages`

| Column            | Type      | Description            |
| ----------------- | --------- | ---------------------- |
| `id`              | BIGSERIAL | Page record ID         |
| `session_id`      | UUID (FK) | Parent session         |
| `page_number`     | INT       | Page number in PDF     |
| `page_path`       | TEXT      | File path on disk      |
| `raw_text`        | TEXT      | Raw Gemini OCR output  |
| `structured_json` | JSONB     | Parsed structured data |

### `affidavit_entries` (Dynamic Key-Value)

| Column           | Type       | Description                               |
| ---------------- | ---------- | ----------------------------------------- |
| `id`             | BIGSERIAL  | Entry ID                                  |
| `session_id`     | UUID (FK)  | Parent session                            |
| `page_id`        | BIGINT(FK) | Source page                               |
| `page_number`    | INT        | Page where field was found                |
| `field_name`     | TEXT       | Dynamic field name (e.g. "candidateName") |
| `field_value`    | TEXT       | Extracted value                           |
| `field_category` | TEXT       | Category for grouping                     |

**Unique constraint:** `(session_id, field_name)` — same field won't duplicate across pages.

### `affidavit_tables`

| Column        | Type       | Description             |
| ------------- | ---------- | ----------------------- |
| `id`          | BIGSERIAL  | Table record ID         |
| `session_id`  | UUID (FK)  | Parent session          |
| `page_id`     | BIGINT(FK) | Source page             |
| `table_title` | TEXT       | Table heading           |
| `headers`     | JSONB      | Array of column headers |
| `rows_data`   | JSONB      | 2D array of row values  |

---

## 🔄 7. Field Categories

Extracted fields are automatically categorized:

| Category               | Fields Included                               |
| ---------------------- | --------------------------------------------- |
| `candidate_info`       | Name, father/mother name, address, party, age |
| `proposer_info`        | Proposer name, serial no, part no             |
| `criminal_record`      | All criminal case details                     |
| `office_of_profit`     | Office of profit declarations                 |
| `insolvency`           | Insolvency declarations                       |
| `foreign_allegiance`   | Foreign allegiance declarations               |
| `disqualification`     | Disqualification details                      |
| `dismissal_corruption` | Dismissal for corruption details              |
| `government_contracts` | Government contract declarations              |
| `assets_movable`       | Cash, bank, investments, vehicles, jewellery  |
| `assets_immovable`     | Land, buildings, property                     |
| `liabilities`          | Loans, government dues                        |
| `general`              | Any other extracted fields                    |

---

## 🎨 8. UI Design Principles

### Color Palette

- **Background:** Deep slate-to-indigo gradient (`from-slate-950 via-blue-950 to-indigo-950`)
- **Cards:** Glassmorphism (`bg-white/5 backdrop-blur border border-white/10`)
- **Primary accent:** Blue/indigo gradients
- **Success:** Emerald/teal gradients
- **Status badges:** Category-specific colors with 10-20% opacity backgrounds

### Design Patterns

1. **Glassmorphic cards** — Semi-transparent with backdrop blur and subtle borders
2. **Gradient accents** — Feature icons, buttons, and highlights use gradients
3. **Smooth animations** — Framer Motion for enter/exit transitions
4. **Responsive grid** — 1/2/3 columns adapting to screen width
5. **Progress feedback** — Real-time polling with animated progress bars
6. **Dark theme** — Consistent dark UI matching the overall aesthetic

---

## ✅ Quick Checklist

- [ ] Install `framer-motion`, `react-router-dom`, `axios`
- [ ] Create `/public/photos/` folder with person images
- [ ] Add `Navbar` component with overflow "More" button
- [ ] Create `Home` page with hero, features, and photo grid
- [ ] Create `AffidavitScanner` page (upload + sessions list)
- [ ] Create `AffidavitDetail` page (tabs: overview, fields, tables, raw)
- [ ] Add routes to React Router for `/affidavits` and `/affidavits/:id`
- [ ] Test upload → processing → DOCX export flow
- [ ] Update `TEAM_PHOTOS` array with real names and photos
