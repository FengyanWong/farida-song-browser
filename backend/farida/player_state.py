"""Persisted queue and playback settings shared by the API and backup validation."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PlayerState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clip_ids: list[str] = Field(default_factory=list, max_length=20000)
    current_id: str | None = Field(default=None, max_length=100)
    name: str = Field(default="播放队列", max_length=200)
    position: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    segment: int = Field(default=0, ge=0, le=99)
    shuffle: bool = False
    skip_unavailable: bool = False
    repeat: Literal["off", "all", "one"] = "off"
    volume: float = Field(default=1, ge=0, le=1, allow_inf_nan=False)
    muted: bool = False
    compact: bool = False
