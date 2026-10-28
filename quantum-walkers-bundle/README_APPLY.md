# How to apply Arena build on your Mac (no /tmp/qw needed)

You tried to run the sandbox commands locally — `/tmp/qw` only exists on the Arena server, not your Mac. Use one of these instead:

## Option A: Download the tarball from this branch (easiest)

1. This branch `arena/8265033e-apex` on `knarayanareddy/apex` now contains `quantum-walkers-bundle/quantum-walkers-arena.tgz`
2. Download it via raw GitHub, then extract over a fresh clone:

```bash
cd ~
rm -rf quantum-walkers quantum-walkers-arena.tgz
git clone https://github.com/TonyBarratt100/quantum-walkers.git
curl -L -o quantum-walkers-arena.tgz https://raw.githubusercontent.com/knarayanareddy/apex/arena/8265033e-apex/quantum-walkers-bundle/quantum-walkers-arena.tgz
tar -xzf quantum-walkers-arena.tgz -C quantum-walkers
cd quantum-walkers
git checkout -b arena-build-96cov
git add -A
git commit -m "feat: production build — 123 tests, 96% cov, package, docs, lint/type"
git push origin arena-build-96cov
gh pr create --title "Production build: package, 123 tests, docs" --body-file quantum-walkers-bundle/README_APPLY.md
```

## Option B: Manual (no download)

Just `git clone` then `pip install -e .[dev]` will NOT work — you need the new files. Use Option A.

## What `tar -xzf` does
Overwrites `hadamard_demo.py`/`coined_walk.py` with shims, adds `src/`, `tests/`, `docs/`, `examples/`, `notebooks/`, `pyproject.toml`, `lint.yml`, etc. Your 15 original tests stay green (subset of 123).
