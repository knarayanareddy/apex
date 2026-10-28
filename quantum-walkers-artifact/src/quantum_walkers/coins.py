"""Coin operators for quantum walks.

A coin is a unitary on the coin register that is applied before the conditional
shift. Different coins give different walk dynamics:

- Hadamard: the canonical unbiased coin, H = 1/√2 [[1,1],[1,-1]]
- Grover: the diffusion operator for search walks, G = 2|s><s| - I
- Fourier: the quantum Fourier transform coin (phase-rich)
"""

import numpy as np
from qiskit.circuit.library import HGate, UnitaryGate
from qiskit.quantum_info import Operator


def hadamard_coin() -> Operator:
    """Return the single-qubit Hadamard coin as an Operator."""
    return Operator(HGate())


def grover_coin(dim: int = 2) -> Operator:
    """Grover diffusion coin: G = 2|s><s| - I for dimension `dim`.

    For dim=2 this is the Hadamard up to a phase/symmetry; for dim>2 it is
    the standard search coin.

    Args:
        dim: Hilbert space dimension (must be >=2).

    Returns:
        Unitary Operator of shape (dim, dim).

    Raises:
        ValueError: If dim < 2.
    """
    if dim < 2:
        raise ValueError(f"dim must be >=2, got {dim}")
    s = np.ones(dim) / np.sqrt(dim)
    G = 2 * np.outer(s, s) - np.eye(dim)
    return Operator(G)


def fourier_coin(dim: int = 2) -> Operator:
    """Fourier (QFT) coin for dimension `dim`.

    Matrix elements: F_{jk} = exp(2πi jk / dim) / sqrt(dim).

    Args:
        dim: Dimension (must be >=2).

    Returns:
        Unitary Operator.

    Raises:
        ValueError: If dim < 2.
    """
    if dim < 2:
        raise ValueError(f"dim must be >=2, got {dim}")
    omega = np.exp(2j * np.pi / dim)
    F = np.array(
        [[omega ** (j * k) for k in range(dim)] for j in range(dim)], dtype=complex
    ) / np.sqrt(dim)
    return Operator(F)


def coin_gate(name: str, dim: int = 2) -> UnitaryGate:
    """Return a coin as a Qiskit gate by name.

    Args:
        name: One of "hadamard", "grover", "fourier", "identity".
        dim: Dimension for grover/fourier coins.

    Raises:
        ValueError: If name is unknown.
    """
    if name == "hadamard":
        if dim != 2:
            raise ValueError("hadamard coin only supports dim=2")
        return HGate()
    if name == "grover":
        return UnitaryGate(grover_coin(dim).data, label=f"G{dim}")
    if name == "fourier":
        return UnitaryGate(fourier_coin(dim).data, label=f"F{dim}")
    if name == "identity":
        return UnitaryGate(np.eye(dim), label="I")
    raise ValueError(
        f"Unknown coin {name!r}; expected one of hadamard, grover, fourier, identity"
    )
