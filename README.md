# Deepresearch.se

A minimal Hello World web application.

## Run locally

```bash
pip install -r requirements.txt
python app.py
# visit http://localhost:8080
```

## Run with Docker

```bash
docker build -t deepresearch-hello .
docker run -p 8080:8080 deepresearch-hello
```

## Endpoints

- `GET /` — returns the hello world greeting
- `GET /health` — health check, returns `{"status": "ok"}`
