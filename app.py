"""Minimal Hello World web application for Deepresearch.se."""
import os

from flask import Flask, jsonify

app = Flask(__name__)


@app.route("/")
def hello():
    return "Hello, World! — Deepresearch.se\n"


@app.route("/health")
def health():
    return jsonify(status="ok")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
