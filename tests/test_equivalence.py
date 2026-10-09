"""Golden-behaviour guard: the new backend must behave exactly like production (BASE_REV) for every
non-concurrent flow. Also proves the harness itself is deterministic (OLD vs OLD)."""
import pytest

from harness import Api, FakeLLM, load_backend
from scenarios import SCENARIOS


def run(kind, name):
    api = Api(load_backend(kind), FakeLLM())
    return SCENARIOS[name](api)


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_harness_is_deterministic(name):
    """Two fresh OLD backends running the same script must agree (else comparisons are meaningless)."""
    assert run("old", name) == run("old", name)


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_new_matches_old(name):
    old, new = run("old", name), run("new", name)
    assert len(old) == len(new)
    for (label_o, val_o), (label_n, val_n) in zip(old, new):
        assert label_o == label_n
        assert val_o == val_n, f"scenario {name!r}, step {label_o!r} differs"
