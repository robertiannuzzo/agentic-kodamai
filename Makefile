.PHONY: test check demo workflow lint bootstrap

PYTHON ?= python3

test:
	$(PYTHON) scripts/test.py
	npm run test:integration

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
