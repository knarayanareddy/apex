# quantum-walkers

[![tests](https://github.com/TonyBarratt100/quantum-walkers/actions/workflows/tests.yml/badge.svg)](https://github.com/TonyBarratt100/quantum-walkers/actions/workflows/tests.yml)
[![lint](https://github.com/TonyBarratt100/quantum-walkers/actions/workflows/lint.yml/badge.svg)](https://github.com/TonyBarratt100/quantum-walkers/actions/workflows/lint.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.10–3.14](https://img.shields.io/badge/python-3.10%20%E2%80%93%203.14-blue)](pyproject.toml)
[![coverage](https://img.shields.io/badge/coverage-96%25-brightgreen)](tests/)
[![Code style: black](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/charliermarsh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)

Quantum walk experiments in [Qiskit](https://www.ibm.com/quantum/qiskit), prepared for the IBM Qiskit Fall Fest hackathon in Amsterdam (20–21 November 2026).

A quantum walk is the quantum version of a random walk. Instead of flipping a real coin at every step, the walker uses a qubit as its coin and moves in a superposition of left and right. The paths interfere, so the walker spreads out **linearly** with the number of steps rather than with its square root. That speed-up underlies several quantum search algorithms.

![Quantum vs classical walk after 15 steps](walk_comparison.png)

## What's here

| Path | What it does |
|------|--------------|
| `src/quantum_walkers/hadamard.py` | Building block: one Hadamard vs two cancel (interference) |
| `src/quantum_walkers/walk.py` | Hadamard-coin walk on a line (32 positions), exact + sampled distributions |
| `src/quantum_walkers/classical.py` | Classical binomial baseline (pure NumPy) |
| `src/quantum_walkers/coins.py` | Alternative coins: Hadamard, Grover, Fourier |
| `src/quantum_walkers/visualization.py` | `plot_comparison` / `plot_walk_evolution` (Agg-safe) |
| `src/quantum_walkers/noise.py` | Depolarizing + readout noise helpers |
| `hadamard_demo.py`, `coined_walk.py` | Backwards-compatible shims re-exporting the package |
| `examples/walk_comparison.py` | Generates `example_output/walk_comparison.png` |
| `examples/hardware_run.py` | IBM Quantum hardware runner (guarded by `QISKIT_IBM_TOKEN`) |
| `tests/` | 115+ pytest checks, 96% line coverage |
| `notebooks/` | `01_hadamard_demo`, `02_walk_on_line`, `03_noise_vs_ideal` |
| `docs/theory.md`, `docs/api.md` | Derivation + API reference |

## Results

**Hadamard demo**, 1,000 shots on `AerSimulator`:

| Circuit | \|0⟩ | \|1⟩ | Why |
|---------|-----|-----|-----|
| `\|0⟩ —H— M` | ~500 | ~500 | H makes an equal superposition (\|0⟩ + \|1⟩)/√2 |
| `\|0⟩ —H—H— M` | 1000 | 0 | H·H = I: the paths to \|1⟩ cancel and to \|0⟩ reinforce |

**Coined walk**, spread (standard deviation of position) after *t* steps:

| Steps | Classical | Quantum |
|-------|-----------|---------|
| 1 | 1.00 | 1.00 |
| 5 | 2.24 | 2.83 |
| 10 | 3.16 | 5.47 |
| 15 | 3.87 | 8.14 |

The classical walker piles up in the middle (a binomial bell curve, σ = √t). The quantum walker is pushed out to two peaks near ±t/√2 and spreads about twice as far after 15 steps, with σ ≈ 0.54 t. A 1,000-shot simulation (bars in the plot) matches the exact statevector result.

For the derivation see [`docs/theory.md`](docs/theory.md).

## How the walk circuit works

- **Registers:** one *coin* qubit, plus five *position* qubits that encode positions 0–31. The walker starts at 16.
- **Each step:** apply a Hadamard to the coin, then move one position right if the coin is \|1⟩ and one left if it is \|0⟩. The move is a controlled increment (+1 mod 32) and its inverse.
- **Initial coin:** (\|0⟩ + i\|1⟩)/√2 gives a symmetric spread. Starting the coin in \|0⟩ or \|1⟩ instead makes the walker drift to one side, which you can try with `coin_state="zero"` or `"one"`.

## Getting started

You need Python 3.10 or later. Developed on 3.11–3.14.

```bash
git clone https://github.com/TonyBarratt100/quantum-walkers.git
cd quantum-walkers

# install package + dev tools (recommended)
python3 -m venv .venv && source .venv/bin/activate
pip install -e .[dev]
pre-commit install

# or minimal (just runtime)
pip install -r requirements.txt
```

Run the demos and the tests:

```bash
python hadamard_demo.py        # 1 vs 2 Hadamards, 1,000 shots each
python coined_walk.py          # spread table + walk_comparison.png
python examples/walk_comparison.py  # writes example_output/walk_comparison.png

pytest                # 115+ tests, 96% coverage (tests/ only)
pytest --no-cov       # without coverage
pytest test_hadamard_demo.py  # legacy flat tests still pass
pytest -m "not slow"  # skip slow sampling test

black --check . && ruff check . && mypy --strict src/quantum_walkers
pre-commit run --all-files
```

## Project layout

```
quantum-walkers/
├── src/quantum_walkers/   # package (hadamard, walk, classical, coins, visualization, noise, utils)
├── tests/                 # pytest suite (test_hadamard, test_walk, test_classical, test_coins, ...)
├── examples/              # runnable scripts (walk_comparison, hardware_run)
├── notebooks/             # 01_hadamard, 02_walk_on_line, 03_noise_vs_ideal
├── docs/                  # theory + API
├── .github/workflows/     # tests.yml (3.10–3.14) + lint.yml
├── pyproject.toml         # single source of truth
├── README.md · SPEC.md · ROADMAP.md · CONTRIBUTING.md
└── hadamard_demo.py / coined_walk.py  # legacy shims
```

## Specification & Done Rubric

The full build spec lives in [`SPEC.md`](SPEC.md) (copy of `QUANTUM_WALKERS_SPEC.md` in this review). Every phase has an explicit "Done when" checklist — the `v0.1.0` ship gate requires 96% coverage, black/ruff/mypy green, demos green, and both CI workflows required.

## Next steps

- Compare coins: Hadamard vs Grover/Fourier, bias sweeps
- Walks on a cycle and on a 2-D grid
- Noise sweeps and IBM Quantum hardware via `qiskit-ibm-runtime`

See [`ROADMAP.md`](ROADMAP.md).

## Licence

[MIT](LICENSE)
