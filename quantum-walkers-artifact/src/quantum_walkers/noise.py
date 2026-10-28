"""Noise models for studying decoherence of the walk (optional, no hardware needed)."""

from qiskit_aer.noise import NoiseModel, ReadoutError, depolarizing_error


def depolarizing_noise_model(
    p1: float = 0.001,
    p2: float = 0.01,
) -> NoiseModel:
    """Return a NoiseModel with single-qubit and two-qubit depolarizing errors.

    Applies to all single-qubit gates (h, x, s) and CX/MCX-like two-qubit gates.

    Args:
        p1: Single-qubit depolarizing probability (0 <= p <= 1).
        p2: Two-qubit depolarizing probability.

    Returns:
        NoiseModel.

    Raises:
        ValueError: If probabilities out of range.
    """
    if not (0 <= p1 <= 1) or not (0 <= p2 <= 1):
        raise ValueError(f"p1 and p2 must be in [0,1], got p1={p1}, p2={p2}")
    model = NoiseModel()
    if p1 > 0:
        err1 = depolarizing_error(p1, 1)
        for gate in ("h", "x", "s", "id", "u1", "u2", "u3"):
            model.add_all_qubit_quantum_error(err1, gate)
    if p2 > 0:
        err2 = depolarizing_error(p2, 2)
        for gate in ("cx", "mcx"):
            model.add_all_qubit_quantum_error(err2, gate)
        # ccx is 3-qubit, needs separate 3-qubit error
        err3 = depolarizing_error(p2, 3)
        model.add_all_qubit_quantum_error(err3, "ccx")
    return model


def readout_error_model(
    p0g1: float = 0.02,
    p1g0: float = 0.02,
) -> NoiseModel:
    """Simple symmetric readout error.

    Args:
        p0g1: P(measure 1 | prepared 0).
        p1g0: P(measure 0 | prepared 1).

    Returns:
        NoiseModel with readout errors on all qubits.

    Raises:
        ValueError: If probabilities out of range.
    """
    if not (0 <= p0g1 <= 1) or not (0 <= p1g0 <= 1):
        raise ValueError(f"readout probabilities must be in [0,1], got {p0g1}, {p1g0}")
    model = NoiseModel()
    ro_error = ReadoutError([[1 - p0g1, p0g1], [p1g0, 1 - p1g0]])
    model.add_all_qubit_readout_error(ro_error)
    return model
