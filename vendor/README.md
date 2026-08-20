# Vendored third-party source

## EverOS

Path: `vendor/everos`
Upstream: https://github.com/EverMind-AI/EverOS
License: Apache-2.0 (see `vendor/everos/LICENSE` and `vendor/everos/NOTICE`)
Pin: git submodule, package version 1.2.3

Yishu long-term memory runs this project.
Do not reimplement extract, cascade, markdown truth, or keyword search.

Study the source here:

- add / flush: `vendor/everos/src/everos/service/memorize.py`
- search: `vendor/everos/src/everos/service/search.py`
- HTTP: `vendor/everos/src/everos/entrypoints/api/routes/`

Do not vendor `tests/fixtures/long_conversation_locomo_caroline_melanie.json` into product paths (CC BY-NC 4.0).
