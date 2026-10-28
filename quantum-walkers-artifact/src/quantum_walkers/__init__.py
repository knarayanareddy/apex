"""quantum_walkers — Qiskit quantum walk experiments for Fall Fest Amsterdam 2026."""

from quantum_walkers.classical import classical_distribution
from quantum_walkers.coins import fourier_coin, grover_coin, hadamard_coin
from quantum_walkers.hadamard import SHOTS, one_hadamard, run, two_hadamards
from quantum_walkers.visualization import plot_comparison, plot_walk_evolution
from quantum_walkers.walk import (
    COIN_STATES,
    POSITION_QUBITS,
    START,
    coined_walk,
    exact_distribution,
    increment,
    sampled_distribution,
    spread,
)

__version__ = "0.1.0"

__all__ = [
    "COIN_STATES",
    "POSITION_QUBITS",
    "SHOTS",
    "START",
    "__version__",
    "classical_distribution",
    "coined_walk",
    "exact_distribution",
    "fourier_coin",
    "grover_coin",
    "hadamard_coin",
    "increment",
    "one_hadamard",
    "plot_comparison",
    "plot_walk_evolution",
    "run",
    "sampled_distribution",
    "spread",
    "two_hadamards",
]
