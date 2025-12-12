# API Demo (curl)

Set a base URL first:

```sh
API=http://localhost:3000
```

## Health

```sh
curl -s "$API/health" | jq
```

## Upload a PDF and create a session (send Gemini key)

Replace `sample.pdf` with your file path. Provide your Gemini key via `apiKey` (or `geminiApiKey`). If you keep it in backend env, this field is optional.

```sh
curl -X POST "$API/sessions" \
  -F "apiKey=$GEMINI_KEY" \
  -F "file=@/path/to/sample.pdf" | jq
```

Response contains `sessionId`.

## List sessions

```sh
curl -s "$API/sessions" | jq
```

## Session status/progress (poll while processing)

```sh
SESSION_ID=<paste-session-id>
curl -s "$API/sessions/$SESSION_ID/status" | jq
```

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

Available filters: name (contains), voterId, gender, minAge, maxAge, houseNumber, relationType, partNumber, section, assembly, serialNumber.

## Global voter search (across sessions)

```sh
curl -s "$API/voters/search?name=ali&partNumber=1" | jq
```

Same filters as above; you can also pass `sessionId` to scope.

## Delete a session

```sh
SESSION_ID=<paste-session-id>
curl -X DELETE "$API/sessions/$SESSION_ID" | jq
```
