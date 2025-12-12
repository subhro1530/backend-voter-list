# API Demo (curl)

Set a base URL first:

```sh
API=http://localhost:3000
```

## Health

```sh
curl -s "$API/health" | jq
```

## Upload a PDF and create a session

Replace `sample.pdf` with your file path.

```sh
curl -X POST "$API/sessions" \
  -F "file=@/path/to/sample.pdf" | jq
```

Response contains `sessionId`.

## List sessions

```sh
curl -s "$API/sessions" | jq
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

## Global voter search (across sessions)

```sh
curl -s "$API/voters/search?name=ali&partNumber=1" | jq
```

## Delete a session

```sh
SESSION_ID=<paste-session-id>
curl -X DELETE "$API/sessions/$SESSION_ID" | jq
```
