"""州 <-> EIA duoarea 映射,以及无州级数据时的 PADD 大区回退.

EIA gnd 数据集只覆盖约 10 个州的州级序列,
其余州回退到所属 PADD 子区/大区的均价 (source='padd').
"""

# 州全名 -> 两字母缩写(与前端 us-atlas properties.name 对齐)
STATE_ABBR: dict[str, str] = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
    "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
    "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
    "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
    "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
    "Wisconsin": "WI", "Wyoming": "WY",
}
ABBR_STATE = {v: k for k, v in STATE_ABBR.items()}

# 州缩写 -> 所属 PADD 子区/大区的 EIA duoarea 码
STATE_PADD: dict[str, str] = {
    # PADD 1A 新英格兰
    "CT": "R1X", "ME": "R1X", "MA": "R1X", "NH": "R1X", "RI": "R1X", "VT": "R1X",
    # PADD 1B 中大西洋
    "DE": "R1Y", "MD": "R1Y", "NJ": "R1Y", "NY": "R1Y", "PA": "R1Y",
    # PADD 1C 南大西洋
    "FL": "R1Z", "GA": "R1Z", "NC": "R1Z", "SC": "R1Z", "VA": "R1Z", "WV": "R1Z",
    # PADD 2 中西部
    "IL": "R20", "IN": "R20", "IA": "R20", "KS": "R20", "KY": "R20", "MI": "R20",
    "MN": "R20", "MO": "R20", "NE": "R20", "ND": "R20", "OH": "R20", "OK": "R20",
    "SD": "R20", "TN": "R20", "WI": "R20",
    # PADD 3 墨西哥湾
    "AL": "R30", "AR": "R30", "LA": "R30", "MS": "R30", "NM": "R30", "TX": "R30",
    # PADD 4 落基山
    "CO": "R40", "ID": "R40", "MT": "R40", "UT": "R40", "WY": "R40",
    # PADD 5 西海岸
    "AK": "R50", "AZ": "R50", "CA": "R50", "HI": "R50", "NV": "R50",
    "OR": "R50", "WA": "R50",
}


def state_duoarea(abbr: str) -> str:
    """州级 duoarea 码,如 CA -> SCA."""
    return f"S{abbr}"
