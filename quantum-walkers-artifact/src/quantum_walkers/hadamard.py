"""Building block: one vs two Hadamard gates and their interference.

The single-qubit Hadamard is its own inverse (H·H = I). Applied once it creates
an equal superposition; applied twice the amplitudes interfere back to |0⟩.
This module is intentionally minimal — it is the pedagogical "Hello, World"
that the coined walk builds on.
"""

from qiskit import QuantumCircuit, transpile
from qiskit_aer import AerSimulator

SHOTS: int = 1000


def one_hadamard() -> QuantumCircuit:
    """|0> -H-> (|0> + |1>)/sqrt(2): an equal superposition."""
    qc = QuantumCircuit(1, 1, name="one_H")
    qc.h(0)
    qc.measure(0, 0)
    return qc


def two_hadamards() -> QuantumCircuit:
    """|0> -H-H-> |0>: H is its own inverse, so the amplitudes interfere back to |0>."""
    qc = QuantumCircuit(1, 1, name="two_H")
    qc.h(0)
    qc.h(0)
    qc.measure(0, 0)
    return qc


def run(
    qc: QuantumCircuit,
    shots: int = SHOTS,
    seed: int | None = None,
    optimization_level: int = 0,
) -> dict[str, int]:
    """Run a circuit on AerSimulator and return measurement counts.

    Args:
        qc: Circuit to execute (must contain measurements).
        shots: Number of shots. Must be a positive int.
        seed: Simulator seed for reproducible sampling. None for non-deterministic.
        optimization_level: Transpiler level. Use 0 to preserve H·H for the
            interference demo (levels ≥1 would cancel the pair before execution).

    Returns:
        Dict mapping bitstring outcome → count (e.g. {"0": 514, "1": 486}).

    Raises:
        ValueError: If shots <= 0 or optimization_level not in 0..3.
    """
    if not isinstance(shots, int) or shots <= 0:
        raise ValueError(f"shots must be a positive int, got {shots!r}")
    if optimization_level not in (0, 1, 2, 3):
        raise ValueError(f"optimization_level must be 0..3, got {optimization_level!r}")

    sim = AerSimulator(seed_simulator=seed)
    # optimization_level=0 keeps both H gates; higher levels would cancel H·H
    result = sim.run(
        transpile(qc, sim, optimization_level=optimization_level), shots=shots
    ).result()
    return result.get_counts()  # type: ignore[no-any-return]


if __name__ == "__main__":  # pragma: no cover
    for circuit in (one_hadamard(), two_hadamards()):
        counts = run(circuit)
        total = sum(counts.values())
        print(f"\n=== {circuit.name} ===")
        print(circuit.draw(output="text"))
        for outcome in ("0", "1"):
            n = counts.get(outcome, 0)
            print(f"  |{outcome}>: {n:4d}  ({n / total:.1%})")
