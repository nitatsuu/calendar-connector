# Every tool lives inside this folder: deleting it removes everything.
ROOT := $(CURDIR)
NODE_VERSION := v26.13.1
NODE_DIST := node-$(NODE_VERSION)-darwin-arm64
export PATH := $(ROOT)/.tools/node/bin:$(ROOT)/node_modules/.bin:$(PATH)
export npm_config_cache := $(ROOT)/.cache/npm
export clasp_config_auth := $(ROOT)/.secrets/.clasprc.json
NODE := $(ROOT)/.tools/node/bin/node
NPM := $(NODE) $(ROOT)/.tools/node/lib/node_modules/npm/bin/npm-cli.js
# One Apps Script project per Google account: make <target> ACCOUNT=personal|kse|...
ACCOUNT ?= personal
PROJECT_DIR := $(ROOT)/deploy/$(ACCOUNT)
CLASP := $(NODE) $(ROOT)/node_modules/@google/clasp/build/src/index.js --user $(ACCOUNT) --project $(PROJECT_DIR)

.PHONY: setup node test login create push open app

setup: node node_modules

node: .tools/node/bin/node

.tools/node/bin/node:
	mkdir -p .cache/dl .tools
	cd .cache/dl && curl -fsSLO https://nodejs.org/dist/$(NODE_VERSION)/$(NODE_DIST).tar.gz \
	  && curl -fsSLO https://nodejs.org/dist/$(NODE_VERSION)/SHASUMS256.txt \
	  && grep " $(NODE_DIST).tar.gz$$" SHASUMS256.txt | shasum -a 256 -c -
	tar -xzf .cache/dl/$(NODE_DIST).tar.gz -C .tools && rm -rf .tools/node && mv .tools/$(NODE_DIST) .tools/node

node_modules: package.json
	$(NPM) install
	touch node_modules

test:
	$(NODE) --test test/

## Log in to Google for clasp (opens a browser) with the account named by ACCOUNT.
login:
	mkdir -p .secrets $(PROJECT_DIR)
	$(CLASP) login

## Create the Apps Script project once per account (writes deploy/$(ACCOUNT)/.clasp.json).
create:
	mkdir -p $(PROJECT_DIR)
	$(CLASP) create --type standalone --title "Calendar Connector ($(ACCOUNT))" --rootDir $(ROOT)/src
	# clasp create may overwrite our manifest with a default one: restore it.
	git checkout -- src/
	git clean -fdq src/

push: test
	$(CLASP) push --force

open:
	$(CLASP) open-script

## Print the web-app URL (HEAD deployment: always the latest pushed code, visible only to me).
app:
	@$(CLASP) list-deployments | awk '/@HEAD/ {print "https://script.google.com/macros/s/" $$2 "/dev"}'
