"""Discrete-time coined quantum walk on a line, plus exact & sampled distributions.

The walker is one coin qubit plus an n-qubit position register (2**n positions,
little-endian). Each step applies a Hadamard to the coin, then moves +1 if the
coin is |1> and -1 if it is |0>. Interference between paths makes the quantum
walker spread linearly in the number of steps, versus sqrt(steps) classically.
"""

from math import comb

import numpy as np
import numpy.typing as npt
from qiskit import ClassicalRegister, QuantumCircuit, QuantumRegister, transpile
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator

POSITION_QUBITS: int = 5  # 32 positions
START: int = 2 ** (POSITION_QUBITS - 1)  # begin in the middle so the walker never wraps
COIN_STATES: tuple[str, ...] = ("symmetric", "zero", "one")


def increment(n: int) -> QuantumCircuit:
    """+1 (mod 2**n) on an n-qubit little-endian register.

    Args:
        n: Number of qubits. Must be >=1.

    Returns:
        Circuit implementing x -> (x+1) mod 2**n as a permutation matrix.

    Raises:
        ValueError: If n < 1.
    """
    if n < 1:
        raise ValueError(f"n must be >=1, got {n}")
    qc = QuantumCircuit(n, name="+1")
    # Flip bit i when all lower bits are 1; go high-to-low so lower bits are still unchanged
    for i in reversed(range(1, n)):
        qc.mcx(list(range(i)), i)
    qc.x(0)
    return qc


def coined_walk(
    steps: int,
    n: int = POSITION_QUBITS,
    start: int = START,
    coin_state: str = "symmetric",
    measure: bool = True,
) -> QuantumCircuit:
    """Build a Hadamard-coin walk of `steps` steps starting at position `start`.

    Args:
        steps: Number of walk steps. Must be >=0.
        n: Number of position qubits (2**n positions).
        start: Starting position (0 <= start < 2**n). The walk must not wrap:
            start ± steps must stay in range.
        coin_state: "symmetric" starts the coin in (|0> + i|1>)/sqrt(2), which
            gives a left-right symmetric distribution; "zero" or "one" give a
            skewed one.
        measure: If True, add classical register and measure the position.

    Returns:
        QuantumCircuit with coin qubit 0 and position qubits 1..n.

    Raises:
        ValueError: If any argument is out of range or coin_state unknown.
    """
    if not isinstance(steps, int) or steps < 0:
        raise ValueError(f"steps must be a non-negative int, got {steps!r}")
    if not isinstance(n, int) or n < 1 or n > 8:
        raise ValueError(f"n must be an int in 1..8, got {n!r}")
    if not isinstance(start, int) or not (0 <= start < 2**n):
        raise ValueError(f"start must be int in 0..{2**n - 1}, got {start!r}")
    if start - steps < 0 or start + steps >= 2**n:
        raise ValueError(
            f"{steps} steps from {start} would wrap around {2**n} positions"
        )
    if coin_state not in COIN_STATES:
        raise ValueError(f"coin_state must be one of {COIN_STATES}, got {coin_state!r}")

    coin = QuantumRegister(1, "coin")
    pos = QuantumRegister(n, "pos")
    qc = QuantumCircuit(coin, pos, name=f"walk_{steps}")

    if coin_state == "symmetric":
        qc.h(coin)
        qc.s(coin)
    elif coin_state == "one":
        qc.x(coin)
    # else "zero": coin already |0>, do nothing
    for i in range(n):
        if (start >> i) & 1:
            qc.x(pos[i])

    step_right = increment(n).to_gate()
    for _ in range(steps):
        qc.h(coin)
        qc.append(step_right.control(1), [coin[0], *pos])
        qc.append(step_right.inverse().control(1, ctrl_state=0), [coin[0], *pos])

    if measure:
        qc.add_register(ClassicalRegister(n, "x"))
        qc.measure(pos, qc.clbits)
    return qc


def exact_distribution(
    steps: int,
    n: int = POSITION_QUBITS,
    start: int = START,
    coin_state: str = "symmetric",
) -> npt.NDArray[np.float64]:
    """Exact probability of each position, from the statevector.

    Args:
        steps: Walk steps.
        n: Position qubits.
        start: Start position.
        coin_state: Coin initialization.

    Returns:
        Array length 2**n with exact probabilities (summing to 1).
    """
    qc = coined_walk(steps, n, start, coin_state, measure=False)
    return Statevector(qc).probabilities(qargs=list(range(1, n + 1)))  # type: ignore[no-any-return]


def sampled_distribution(
    steps: int,
    shots: int = 1000,
    seed: int | None = None,
    n: int = POSITION_QUBITS,
    start: int = START,
    coin_state: str = "symmetric",
) -> npt.NDArray[np.float64]:
    """Position frequencies from `shots` measurements on AerSimulator.

    Args:
        steps: Walk steps.
        shots: Number of shots (must be >0).
        seed: Simulator seed (None for non-deterministic).
        n: Position qubits.
        start: Start position.
        coin_state: Coin initialization.

    Returns:
        Array length 2**n with empirical probabilities.

    Raises:
        ValueError: If shots <=0.
    """
    if not isinstance(shots, int) or shots <= 0:
        raise ValueError(f"shots must be a positive int, got {shots!r}")
    sim = AerSimulator(seed_simulator=seed)
    qc = transpile(coined_walk(steps, n, start, coin_state), sim)
    counts = sim.run(qc, shots=shots).result().get_counts()
    probs = np.zeros(2**n, dtype=np.float64)
    for bits, count in counts.items():
        probs[int(bits, 2)] = count / shots
    return probs


def classical_distribution(
    steps: int, n: int = POSITION_QUBITS, start: int = START
) -> npt.NDArray[np.float64]:
    """Fair-coin random walk: binomial over the 2**n positions.

    Kept here for backwards compatibility; canonical is `quantum_walkers.classical`.

    Args:
        steps: Steps.
        n: Position qubits.
        start: Start position.

    Returns:
        Array length 2**n.
    """
    # Inline to avoid circular import at runtime (classical.py imports nothing from walk.py)
    if steps < 0:
        raise ValueError(f"steps must be non-negative, got {steps}")
    probs = np.zeros(2**n, dtype=np.float64)
    for k in range(steps + 1):  # k steps right, steps - k left
        probs[start + 2 * k - steps] = comb(steps, k) / 2**steps
    return probs


def spread(probs: npt.NDArray[np.float64]) -> float:
    """Standard deviation of position.

    Args:
        probs: 1-D probability vector (must sum to 1).

    Returns:
        Standard deviation as float.

    Raises:
        ValueError: If probs is not 1-D or empty.
    """
    if probs.ndim != 1:
        raise ValueError(f"probs must be 1-D, got ndim={probs.ndim}")
    if len(probs) == 0:
        raise ValueError("probs must be non-empty")
    x = np.arange(len(probs), dtype=np.float64)
    mean = float(probs @ x)
    return float(np.sqrt(float(probs @ ((x - mean) ** 2))))


def plot_comparison(
    steps: int = 15, shots: int = 1000, path: str = "walk_comparison.png"
) -> None:
    """Plot quantum vs classical walk and save to `path` (delegates to visualization)."""
    from quantum_walkers.visualization import plot_comparison as _plot

    _plot(steps=steps, shots=shots, path=path)


if __name__ == "__main__":  # pragma: no cover
    from quantum_walkers.classical import classical_distribution as _cd

    print(f"{'steps':>5}  {'classical σ':>11}  {'quantum σ':>9}")
    for t in (1, 5, 10, 15):
        print(f"{t:5d}  {spread(_cd(t)):11.2f}  {spread(exact_distribution(t)):9.2f}")
    plot_comparison()
    print("\nSaved walk_comparison.png")
