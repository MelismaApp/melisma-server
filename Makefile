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
	@mkdir -p data
	@if [ -f data/better-lyrics.db ]; then \
	  aside="data/replaced-$$(date +%Y%m%d-%H%M%S).db"; \
	  mv data/better-lyrics.db "$$aside"; \
	  echo "Moved the current local database to $$aside"; \
	fi
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
#   docker run --rm -v better-lyrics-data:/data -v "$PWD:/in" alpine \
#     sh -c 'cp /in/<backup>.db /data/better-lyrics.db && chmod 600 /data/better-lyrics.db'
#   exit
#   kamal app boot
#
# The container must be stopped for it: SQLite will not thank you for swapping the file underneath a
# process that has it open.

backup: ## Copy the deployed database here, timestamped
	@# The one piece of state worth keeping: every archived provider response, and the tokens.
	@#
	@# Two things this has to work around. Kamal writes its own progress to stdout, which lands
	@# in the middle of the file and leaves sqlite saying "file is not a database" -- `-q` quiets
	@# it, and the tail below drops anything that still gets through by starting the output at
	@# sqlite's magic header. And the timestamp is computed once, into a variable, because naming
	@# the file and reporting it in two separate `date` calls can straddle a second and print a
	@# name that does not exist.
	@set -e; \
	  out="melisma-$$(date +%Y%m%d-%H%M%S).db"; \
	  kamal app exec -q --reuse "cat /data/better-lyrics.db" \
	    | python3 -c 'import sys; d=sys.stdin.buffer.read(); i=d.find(b"SQLite format 3\x00"); sys.exit("no sqlite header in output") if i<0 else sys.stdout.buffer.write(d[i:])' \
	    > "$$out"; \
	  sqlite3 "$$out" "pragma integrity_check;" | head -1; \
	  echo "Wrote $$out"
