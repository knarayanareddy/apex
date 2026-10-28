"""Shared validators and helpers."""

import numpy as np
import numpy.typing as npt


def validate_probs(probs: npt.NDArray[np.float64]) -> None:
    """Assert probs is a 1-D probability vector summing to ~1."""
    if probs.ndim != 1:
        raise ValueError(f"probs must be 1-D, got ndim={probs.ndim}")
    if len(probs) == 0:
        raise ValueError("probs must be non-empty")
    total = float(probs.sum())
    if not np.isclose(total, 1.0, atol=1e-9):
        raise ValueError(f"probs must sum to 1, got {total}")


def parity_mask(n: int, start: int, steps: int) -> npt.NDArray[np.bool_]:
    """Boolean mask: True for positions reachable after `steps` from `start`."""
    positions = np.arange(2**n)
    result: npt.NDArray[np.bool_] = (positions % 2) == ((start + steps) % 2)
    return result
