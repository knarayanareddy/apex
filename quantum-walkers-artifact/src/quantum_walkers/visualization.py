"""Plotting helpers for quantum vs classical walks (Agg backend for CI)."""

import numpy as np
import numpy.typing as npt

from quantum_walkers.walk import (
    POSITION_QUBITS,
    START,
    exact_distribution,
    sampled_distribution,
    spread,
)


def plot_comparison(
    steps: int = 15,
    shots: int = 1000,
    path: str = "walk_comparison.png",
    n: int = POSITION_QUBITS,
    start: int = START,
) -> None:
    """Plot quantum vs classical walk after `steps` steps and save to `path`.

    Args:
        steps: Walk steps.
        shots: Shots for sampled bar overlay.
        path: Output PNG path.
        n: Position qubits.
        start: Start position.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from quantum_walkers.classical import classical_distribution

    quantum = exact_distribution(steps, n=n, start=start)
    sampled = sampled_distribution(steps, shots=shots, seed=7, n=n, start=start)
    classical = classical_distribution(steps, n=n, start=start)
    x = np.arange(start - steps, start + steps + 1, 2)

    fig, ax = plt.subplots(figsize=(9, 4.5))
    ax.plot(
        x - start,
        classical[x],
        "o-",
        color="#888888",
        label=f"Classical (σ = {spread(classical):.2f})",
    )
    ax.plot(
        x - start,
        quantum[x],
        "o-",
        color="#3b5bdb",
        label=f"Quantum, exact (σ = {spread(quantum):.2f})",
    )
    ax.bar(
        x - start,
        sampled[x],
        width=1.2,
        color="#3b5bdb",
        alpha=0.25,
        label=f"Quantum, {shots} shots on AerSimulator",
    )
    ax.set_xlabel("Position relative to start")
    ax.set_ylabel("Probability")
    ax.set_title(
        f"Hadamard-coin quantum walk vs classical random walk after {steps} steps"
    )
    ax.set_ylim(0, 1.5 * max(quantum.max(), classical.max()))
    ax.legend(frameon=False, loc="upper center", ncol=2)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_walk_evolution(
    steps_list: npt.NDArray[np.int_] | list[int] | tuple[int, ...] = (1, 5, 10, 15),
    path: str = "walk_evolution.png",
    n: int = POSITION_QUBITS,
    start: int = START,
) -> None:
    """Plot exact quantum distribution for multiple step counts on one figure.

    Args:
        steps_list: Iterable of step counts.
        path: Output path.
        n: Position qubits.
        start: Start position.
    """
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    steps_arr = list(steps_list)
    fig, axes = plt.subplots(
        len(steps_arr), 1, figsize=(9, 2.5 * len(steps_arr)), sharex=True
    )
    if len(steps_arr) == 1:
        axes = [axes]
    for ax, t in zip(axes, steps_arr, strict=False):
        probs = exact_distribution(t, n=n, start=start)
        x = np.arange(start - t, start + t + 1, 2)
        ax.bar(x - start, probs[x], width=0.9, color="#3b5bdb", alpha=0.8)
        ax.set_ylabel(f"t={t}")
        ax.set_ylim(0, probs.max() * 1.3)
        ax.spines[["top", "right"]].set_visible(False)
    axes[-1].set_xlabel("Position relative to start")
    fig.suptitle("Quantum walk evolution (exact)")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
