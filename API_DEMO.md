# API Demo (curl)

Set a base URL first:

```sh
API=http://localhost:3000
```

## Health

```sh
curl -s "$API/health" | jq
```

## API Key Management

The system has 7 hardcoded API keys with automatic fallback. When one key's quota is exhausted, it automatically switches to the next available key.

### Check API Key Status

```sh
curl -s "$API/api-keys/status" | jq
```

Response shows which keys are active/exhausted:

```json
{
  "totalKeys": 7,
  "activeKeys": 5,
  "exhaustedKeys": 2,
  "allExhausted": false,
  "keys": [
    { "keyIndex": 1, "keyPreview": "AIzaSyCCAq...FINw", "status": "active" },
    {
      "keyIndex": 2,
      "keyPreview": "AIzaSyB5pQ...T884",
      "status": "exhausted",
      "exhaustedAt": "...",
      "lastError": "..."
    }
  ]
}
```

### Reset All API Keys (useful after daily quota reset)

```sh
curl -X POST "$API/api-keys/reset" | jq
```

## Upload a PDF and create a session

Replace `sample.pdf` with your file path. The `apiKey` is now optional - the system will use hardcoded fallback keys.

```sh
curl -X POST "$API/sessions" \
  -F "file=@/path/to/sample.pdf" | jq

# Or with your own API key (optional)
curl -X POST "$API/sessions" \
  -F "apiKey=$GEMINI_KEY" \
  -F "file=@/path/to/sample.pdf" | jq
```

Response contains `sessionId`. If all keys are exhausted mid-processing, the session will be "paused" and can be resumed later.

## Resume a paused session

If a session was paused due to API key exhaustion, resume it later:

```sh
SESSION_ID=<paste-session-id>
curl -X POST "$API/sessions/$SESSION_ID/resume" | jq

# Or with a specific API key
curl -X POST "$API/sessions/$SESSION_ID/resume" \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "your-api-key"}' | jq
```

## List sessions

```sh
curl -s "$API/sessions" | jq
```

## Session status/progress (poll while processing)

```sh
SESSION_ID=<paste-session-id>
curl -s "$API/sessions/$SESSION_ID/status" | jq
```

Status values: `processing`, `completed`, `paused` (can be resumed), `failed`

## Get a specific session (with page data)

```sh
SESSION_ID=<paste-session-id>
curl -s "$API/sessions/$SESSION_ID" | jq
```

## Filter voters within a session

```sh
SESSION_ID=<paste-session-id>
curl -s "$API/sessions/$SESSION_ID/voters?name=kundu&gender=female&minAge=18" | jq
```

Available filters: name (contains), voterId, gender, minAge, maxAge, houseNumber, relationType, partNumber, section, assembly, serialNumber, religion.

### Filter by religion

```sh
SESSION_ID=<paste-session-id>
# Get only Muslim voters
curl -s "$API/sessions/$SESSION_ID/voters?religion=Muslim" | jq

# Get only Hindu voters
curl -s "$API/sessions/$SESSION_ID/voters?religion=Hindu" | jq

# Combine with other filters
curl -s "$API/sessions/$SESSION_ID/voters?religion=Muslim&gender=female&minAge=18" | jq
```

Religion values: Muslim, Hindu, Christian, Sikh, Buddhist, Jain, Other

## Get religion statistics for a session

```sh
SESSION_ID=<paste-session-id>
curl -s "$API/sessions/$SESSION_ID/stats/religion" | jq
```

## Global voter search (across sessions)

```sh
curl -s "$API/voters/search?name=ali&partNumber=1" | jq
```

Same filters as above (including religion); you can also pass `sessionId` to scope.

## Delete a session

```sh
SESSION_ID=<paste-session-id>
curl -X DELETE "$API/sessions/$SESSION_ID" | jq
```
