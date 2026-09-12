"""Thin Metabase REST client for read-only extraction.

Auth uses an API key (Metabase 0.49+) sent as the `x-api-key` header.
The key is read from the environment and must never be committed or
shipped to the browser.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Iterable

import requests

# /api/dataset is capped at ~2000 rows (it is the endpoint the UI uses for
# display). The export endpoints are the ones that stream a full result set,
# so anything that needs every row goes through /api/dataset/json.
DISPLAY_ENDPOINT = "/api/dataset"
EXPORT_ENDPOINT = "/api/dataset/json"


class MetabaseError(RuntimeError):
    pass


class Metabase:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout: int = 600,
    ) -> None:
        base_url = base_url or os.environ.get("METABASE_URL", "")
        api_key = api_key or os.environ.get("METABASE_API_KEY", "")
        if not base_url:
            raise MetabaseError(
                "METABASE_URL is not set. Copy .env.example to .env and fill it in."
            )
        if not api_key:
            raise MetabaseError(
                "METABASE_API_KEY is not set. Copy .env.example to .env and fill it in."
            )
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {"x-api-key": api_key, "Accept": "application/json"}
        )

    # -- plumbing -----------------------------------------------------------
    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = f"{self.base_url}{path}"
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                resp = self.session.request(
                    method, url, timeout=self.timeout, **kwargs
                )
            except requests.RequestException as exc:
                last_err = exc
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 401:
                raise MetabaseError(
                    "401 from Metabase: the API key was rejected. Check that the key "
                    "is active and that METABASE_URL points at the right instance."
                )
            if resp.status_code == 403:
                raise MetabaseError(
                    f"403 from Metabase for {path}: the key's permission group lacks "
                    "access. For native SQL the group needs 'Native query editing' on "
                    "the target database."
                )
            if resp.status_code >= 500:
                last_err = MetabaseError(f"{resp.status_code} from {path}")
                time.sleep(2 ** attempt)
                continue
            if not resp.ok:
                raise MetabaseError(
                    f"{resp.status_code} from {path}: {resp.text[:500]}"
                )
            return resp
        raise MetabaseError(f"Gave up on {path} after 3 attempts: {last_err}")

    def get(self, path: str, **params: Any) -> Any:
        return self._request("GET", path, params=params or None).json()

    # -- discovery ----------------------------------------------------------
    def databases(self) -> list[dict]:
        payload = self.get("/api/database")
        # Metabase returns a bare list on older versions, {"data": [...]} on newer.
        return payload["data"] if isinstance(payload, dict) else payload

    def database_metadata(self, database_id: int) -> dict:
        """Full table + field listing for one database."""
        return self.get(f"/api/database/{database_id}/metadata")

    def search_tables(self, database_id: int, needle: str) -> list[dict]:
        meta = self.database_metadata(database_id)
        needle = needle.lower()
        return [
            t
            for t in meta.get("tables", [])
            if needle in (t.get("name") or "").lower()
            or needle in (t.get("display_name") or "").lower()
        ]

    # -- querying -----------------------------------------------------------
    def query(self, sql: str, database_id: int, full: bool = True) -> list[dict]:
        """Run native SQL and return a list of row dicts keyed by column name.

        full=True streams the whole result set via the export endpoint.
        full=False uses the display endpoint, which truncates at ~2000 rows but
        preserves Metabase's column type metadata -- handy for probing.
        """
        payload = {
            "database": database_id,
            "type": "native",
            "native": {"query": sql},
        }
        if full:
            resp = self._request(
                "POST",
                EXPORT_ENDPOINT,
                data={"query": json.dumps(payload), "format_rows": "false"},
            )
            rows = resp.json()
            if isinstance(rows, dict) and rows.get("error"):
                raise MetabaseError(f"Query failed: {rows['error']}")
            return rows
        body = self._request("POST", DISPLAY_ENDPOINT, json=payload).json()
        if body.get("status") == "failed" or body.get("error"):
            raise MetabaseError(
                f"Query failed: {body.get('error') or body.get('status')}"
            )
        data = body["data"]
        names = [c.get("name") for c in data["cols"]]
        return [dict(zip(names, row)) for row in data["rows"]]

    def query_file(self, path: str, database_id: int, **fmt: Any) -> list[dict]:
        with open(path, "r", encoding="utf-8") as fh:
            sql = fh.read()
        if fmt:
            sql = sql.format(**fmt)
        return self.query(sql, database_id)


def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader so we don't need python-dotenv as a dependency."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
