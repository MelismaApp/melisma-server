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
        console remote-key restart rollback stop backup

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

backup: ## Copy the deployed database here, timestamped
	@# The one piece of state worth keeping: every archived provider response, and the tokens.
	kamal app exec --reuse "cat /data/better-lyrics.db" > "melisma-$$(date +%Y%m%d-%H%M%S).db"
	@echo "Wrote melisma-$$(date +%Y%m%d-%H%M%S).db"
