"""Classical random walk baseline — pure NumPy, no Qiskit dependency.

The fair-coin walk after t steps is a binomial distribution:
after k right-steps and (t-k) left-steps the walker is at start + 2k - t
with probability C(t,k)/2^t. Spread (std dev) = sqrt(t).
"""

from math import comb

import numpy as np
import numpy.typing as npt


def classical_distribution(
    steps: int,
    n: int = 5,
    start: int = 16,
) -> npt.NDArray[np.float64]:
    """Fair-coin random walk distribution over 2**n positions.

    Args:
        steps: Number of coin flips / moves. Must be >=0.
        n: Number of position qubits; positions = 0..2**n -1.
        start: Starting position.

    Returns:
        Array length 2**n with probabilities summing to 1. Only positions
        with parity == (start + steps) % 2 are reachable.

    Raises:
        ValueError: If steps < 0, n <=0, or start out of range, or walk would
            extend beyond 0..2**n-1 (same wrap guard as coined_walk).
    """
    if steps < 0:
        raise ValueError(f"steps must be non-negative, got {steps}")
    if n <= 0:
        raise ValueError(f"n must be positive, got {n}")
    if not (0 <= start < 2**n):
        raise ValueError(f"start must be in 0..{2**n -1}, got {start}")
    if start - steps < 0 or start + steps >= 2**n:
        raise ValueError(
            f"{steps} steps from {start} would wrap around {2**n} positions"
        )

    probs = np.zeros(2**n, dtype=np.float64)
    for k in range(steps + 1):  # k steps right, steps-k left
        pos = start + 2 * k - steps
        probs[pos] = comb(steps, k) / 2**steps
    return probs
