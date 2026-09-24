.PHONY: test e2e check demo workflow lint bootstrap

PYTHON ?= python3

test:
	$(PYTHON) scripts/test.py
	npm run test:integration

e2e:
	npm run test:e2e

check:
	./scripts/idris --typecheck recruitment.ipkg

demo:
	./scripts/idris --build demo.ipkg
	./build/exec/recruitment-demo

workflow:
	./scripts/idris --build workflow.ipkg

lint:
	$(PYTHON) scripts/lint.py

bootstrap:
	./scripts/bootstrap-idris
