# API Demo (curl)

**Created by Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app) | © 2026 All Rights Reserved

Set a base URL first:

```sh
API=http://localhost:4000
TOKEN="your-jwt-token"  # Get from /auth/login
```

## Authentication

### Register

```sh
curl -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123", "name": "John Doe"}' | jq
```

### Login

```sh
curl -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123"}' | jq
```

Save the token from login response for authenticated requests.

## Health & System Info

```sh
curl -s "$API/health" | jq

# System info (requires auth)
curl -s "$API/system/info" -H "Authorization: Bearer $TOKEN" | jq
```

## 🤖 Intelligent Chatbot

The chatbot understands natural language and executes actions based on your role.

### Chat with the Bot

```sh
curl -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Find voters named Kumar"}' | jq
```

### Example Queries:

- "Search for voter with ID ABC123"
- "Show me all sessions" (admin only)
- "What are the religion statistics?"
- "Check API status"
- "Reset API keys" (admin only)
- "Show my profile"
- "List all assemblies"

### Get Available Chat Actions

```sh
curl -s "$API/chat/actions" -H "Authorization: Bearer $TOKEN" | jq
```

## 🚀 API Engine Management (7 Parallel Engines)

The system uses 7 API keys as independent processing engines for parallel PDF processing.

### Check Engine Status (Admin only)

```sh
curl -s "$API/api-keys/status" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Response shows detailed engine metrics:

```json
{
  "totalEngines": 7,
  "activeEngines": 7,
  "exhaustedEngines": 0,
  "busyEngines": 3,
  "availableEngines": 4,
  "allExhausted": false,
  "engines": [
    {
      "engineId": 1,
      "status": "active",
      "busy": false,
      "metrics": {
        "totalRequests": 45,
        "successCount": 44,
        "failureCount": 1,
        "engineProcessed": 44
      }
    }
  ]
}
```

### Reset All Engines (Admin only)

```sh
curl -X POST "$API/api-keys/reset" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## 📄 Upload PDF (Parallel Processing)

Upload a PDF and it will be processed using all 7 engines in parallel!

```sh
curl -X POST "$API/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/sample.pdf" | jq
```

A 44-page PDF will be processed in batches using all available engines.

## Resume a Paused Session

If a session was paused (rare with 7 engines), resume it:

```sh
SESSION_ID=<paste-session-id>
curl -X POST "$API/sessions/$SESSION_ID/resume" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## List Sessions (Admin only)

```sh
curl -s "$API/sessions" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Session Status (Admin only)

```sh
SESSION_ID=<paste-session-id>
curl -s "$API/sessions/$SESSION_ID/status" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Search Voters

### User Search (limited fields)

```sh
curl -s "$API/user/voters/search?name=kumar&assembly=123" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Admin Search (full access)

```sh
curl -s "$API/admin/voters?name=kumar&religion=Hindu&minAge=18" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Filter by Religion

```sh
curl -s "$API/admin/voters?religion=Muslim&gender=female" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Religion values: Muslim, Hindu, Christian, Sikh, Buddhist, Jain, Other

## Statistics (Admin only)

### Religion Stats

```sh
curl -s "$API/admin/stats/religion" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Gender Stats

```sh
curl -s "$API/admin/stats/gender" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Print Stats

```sh
curl -s "$API/admin/stats/prints" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## User Routes

### Get Profile

```sh
curl -s "$API/user/profile" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Get Assemblies

```sh
curl -s "$API/user/assemblies" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Mark Voter as Printed

```sh
VOTER_ID=123
curl -X POST "$API/user/voters/$VOTER_ID/print" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Delete Session (Admin only)

```sh
SESSION_ID=<paste-session-id>
curl -X DELETE "$API/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 🏗️ Architecture

- **7 Parallel API Engines**: Each Gemini API key runs as an independent engine
- **Automatic Recovery**: Exhausted engines recover after 60 seconds
- **Smart Batching**: Pages are processed in parallel batches
- **No More Stopping**: Processing continues even if some engines are exhausted
- **Real-time Status**: Track each engine's performance and status

## 📱 Frontend Integration

The frontend should:

1. Use `/chat` endpoint for natural language queries
2. Display engine status from `/api-keys/status`
3. Show processing progress during PDF upload
4. Display data in tables using markdown from chat responses

---

**© 2026 Shaswata Saha** | [ssaha.vercel.app](https://ssaha.vercel.app)
