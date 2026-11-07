#!/bin/sh
# Prints one Vercel deployment's state, URL, commit and aliases from the REST API with curl, the light path heavy-check.ts names on the
# owner's Mac for `vercel inspect`. Usage: vercel-deployment.sh <deployment id, deployment URL or alias> [team slug, default sieuns-projects]
set -eu
target=${1:?usage: vercel-deployment.sh <dpl id, deployment URL or alias> [team slug]}
team=${2:-sieuns-projects}
target=${target#https://}
target=${target%%/*}
token=${VERCEL_TOKEN:-}
if [ -z "$token" ]; then
	for file in "$HOME/Library/Application Support/com.vercel.cli/auth.json" "${XDG_DATA_HOME:-$HOME/.local/share}/com.vercel.cli/auth.json"; do
		[ -f "$file" ] || continue
		token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1)
		[ -n "$token" ] && break
	done
fi
[ -n "$token" ] || { echo "vercel-deployment.sh: no Vercel token; set VERCEL_TOKEN or run vercel login" >&2; exit 2; }
curl -sS -H "Authorization: Bearer $token" "https://api.vercel.com/v13/deployments/$target?slug=$team" | python3 -c '
import json, sys, datetime
d = json.load(sys.stdin)
if "error" in d:
    sys.exit("vercel-deployment.sh: " + d["error"].get("code", "") + ": " + d["error"].get("message", ""))
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ms else ""
meta = d.get("meta") or {}
for key, value in [("id", d.get("id")), ("name", d.get("name")), ("state", d.get("readyState")), ("target", d.get("target") or "preview"),
        ("url", "https://" + d.get("url", "")), ("created", iso(d.get("createdAt"))), ("ready", iso(d.get("ready"))),
        ("commit", meta.get("githubCommitSha", "")), ("branch", meta.get("githubCommitRef", "")),
        ("message", (meta.get("githubCommitMessage") or "").splitlines()[0] if meta.get("githubCommitMessage") else ""),
        ("aliases", " ".join((d.get("alias") or []) + (d.get("automaticAliases") or [])))]:
    print(key + "\t" + str(value or ""))
'
