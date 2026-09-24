# Melisma Server — operational commands.
#
# Most targets delegate to Kamal. Requires Kamal 2.x (gem install kamal).
#
# First-time setup:
#   1. cp .kamal/secrets.sample .kamal/secrets  && fill in values
#   2. edit config/deploy.yml and replace the TODO(...) markers
#   3. make setup        (builds image, pushes, boots server, boots app)
#
# Regular workflow:
#   make deploy          (rebuild + ship)
#   make logs            (tail app logs)
#   make key             (print the API key the app and the admin page need)
#   make console         (open a shell inside the running container)

.PHONY: help install dev test key new-key \
        docker-build docker-run setup deploy redeploy logs app-logs \
        console remote-key restart rollback stop backup restore

help:
	@grep -E '^[a-zA-Z_-]+:.*?##' Makefile | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

install: ## Nothing to install — zero dependencies. Checks the Node version instead.
	@node -e "const [major] = process.versions.node.split('.').map(Number); \
	  if (major < 24) { console.error('Node 24+ required, found ' + process.versions.node); process.exit(1); } \
	  console.log('Node ' + process.versions.node + ' — good. No dependencies to install.')"

dev: ## Local server on :8787, restarting on change
	npm run dev

test: ## Run the suite (no network required)
	npm test

key: ## Print the local API key
	npm run key

new-key: ## Rotate the local API key
	node scripts/key.ts --new

docker-build: ## Build the image locally
	docker build -t melisma-server:local .

docker-run: ## Run the image locally on :8787 with a persistent volume
	docker run --rm -p 8787:8787 -v better-lyrics-data:/data melisma-server:local

setup: ## First-time Kamal bootstrap on the target host
	kamal setup

deploy: ## Rebuild and ship the latest code
	kamal deploy

redeploy: ## Redeploy without rebuilding (hot roll current image)
	kamal redeploy

logs: ## Stream proxy + app logs
	kamal logs -f

app-logs: ## Stream just app container logs
	kamal app logs -f

console: ## Open a shell inside the running container
	kamal app exec --interactive --reuse sh

remote-key: ## Print the deployed server's API key
	kamal app exec --interactive --reuse "node scripts/key.ts"

restart: ## Restart the app containers
	kamal app restart

rollback: ## Roll back to the previous image version
	kamal rollback

stop: ## Stop the app (leaves the proxy up)
	kamal app stop

restore: ## Load a backup into the LOCAL database (FILE=melisma-....db)
	@test -n "$(FILE)" || { echo "Usage: make restore FILE=melisma-YYYYMMDD-HHMMSS.db"; exit 1; }
	@test -f "$(FILE)" || { echo "No such file: $(FILE)"; exit 1; }
	@# Whatever is here already is a cache and a set of tokens. Moved aside, never overwritten: the
	@# whole point of a restore is that you are unsure, and an unsure operation must not destroy.
	@# The `-wal` and `-shm` files go with it. Left behind, SQLite would replay the old database's
	@# pending writes onto the restored one the next time it opened. Each is moved on its own, so a
	@# sidecar left by an interrupted restore goes even when the main file is already gone. Stop a
	@# local server first.
	@mkdir -p data
	@aside="data/replaced-$$(date +%Y%m%d-%H%M%S).db"; moved=""; \
	  for part in "" -wal -shm; do \
	    if [ -f "data/better-lyrics.db$$part" ]; then \
	      mv "data/better-lyrics.db$$part" "$$aside$$part"; moved="$$moved data/better-lyrics.db$$part"; \
	    fi; \
	  done; \
	  if [ -n "$$moved" ]; then echo "Moved aside to $$aside*:$$moved"; fi
	@cp "$(FILE)" data/better-lyrics.db
	@chmod 600 data/better-lyrics.db
	@echo "Restored $(FILE). It holds real tokens — it is chmod 600 and gitignored."
	@echo "Run 'npm start' to serve it."

# Restoring onto the *deployed* server is deliberately not a target.
#
# It replaces the live cache and every pasted credential at once, from a file whose provenance only you
# know, on the one machine where getting it wrong means re-pasting an Apple token you may not be able to
# read again. That deserves typing out, not a word. If you mean it:
#
#   make backup                                    # first, so there is a way back
#   kamal app stop
#   ssh <user>@<host>
#   docker run --rm -v better-lyrics-data:/data -v "$PWD:/in" alpine sh -c '
#     for f in better-lyrics.db better-lyrics.db-wal better-lyrics.db-shm; do
#       if [ -f /data/$f ]; then mv /data/$f /data/replaced-$f; fi; done
#     cp /in/<backup>.db /data/better-lyrics.db && chmod 600 /data/better-lyrics.db'
#
# The `-wal` and `-shm` files are moved too: SQLite would otherwise replay the old database's pending
# writes onto the restored one at boot.
#   exit
#   kamal app boot
#
# The container must be stopped for it: SQLite will not thank you for swapping the file underneath a
# process that has it open.

backup: ## Copy the deployed database here, timestamped
	@# The one piece of state worth keeping: every archived provider response, and the tokens.
	@#
	@# Not `cat` of the file, and not Kamal's output taken as-is. The database is in WAL mode, so a
	@# plain copy misses every write not yet checkpointed; and Kamal rewrites the last byte of its
	@# output when it is a carriage return. scripts/backup.ts makes a consistent copy on the server and
	@# frames it with its length and checksum, and its `--receive` refuses anything that does not match.
	@#
	@# `umask 077` because the copy holds the tokens in the clear. A failed transfer removes its file
	@# rather than leaving one that looks like a backup. The timestamp is computed once, into a
	@# variable, because two separate `date` calls can straddle a second and report a name that does
	@# not exist.
	@set -e; umask 077; \
	  out="melisma-$$(date +%Y%m%d-%H%M%S).db"; \
	  if ! kamal app exec -q --reuse "node scripts/backup.ts" | node scripts/backup.ts --receive > "$$out"; then \
	    rm -f "$$out"; echo "Backup failed; nothing written" >&2; exit 1; \
	  fi; \
	  check="$$(sqlite3 "$$out" 'pragma integrity_check;' | head -1)"; \
	  if [ "$$check" != ok ]; then echo "Wrote $$out, but integrity_check says: $$check" >&2; exit 1; fi; \
	  echo "Wrote $$out (checksum verified, integrity ok)"
