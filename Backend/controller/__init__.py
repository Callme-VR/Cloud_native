"""
Controller Package
------------------
Exports the API router for inclusion in the brain FastAPI application.
"""

from controller._routes import api_router

__all__ = ["api_router"]
