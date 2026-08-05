"""Virtual Lab package."""

from virtual_lab.__about__ import __version__
from virtual_lab.agent import Agent
from virtual_lab.run_meeting import run_meeting


__all__ = [
    "__version__",
    "Agent",
    "run_meeting",
]
