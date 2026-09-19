.PHONY: test check demo lint bootstrap

PYTHON ?= python3

test:
	$(PYTHON) scripts/test.py

check:
	./scripts/idris --typecheck recruitment.ipkg

demo:
	./scripts/idris --build demo.ipkg
	./build/exec/recruitment-demo

lint:
	$(PYTHON) scripts/lint.py

bootstrap:
	./scripts/bootstrap-idris
