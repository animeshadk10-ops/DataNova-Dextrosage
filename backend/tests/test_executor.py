from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.models.enums import RecommendedAction
from app.services.executor import execute_action


@pytest.fixture
def df():
    return pd.DataFrame(
        {
            "age": [20.0, np.nan, 40.0, np.nan, 60.0],
            "city": ["NEW York", "los angeles", "New York", "Austin", "New York"],
            "dropme": [1, 2, 3, 4, 5],
            "revenue": [1.0, 10.0, 100.0, -5.0, 1000.0],
        }
    )


def test_impute_median(df):
    out, before, after = execute_action(df, "age", RecommendedAction.impute_median)
    assert out["age"].isna().sum() == 0
    assert before["missing_pct"] == 40.0
    assert after["missing_pct"] == 0.0


def test_impute_mode(df):
    out, before, after = execute_action(df, "city", RecommendedAction.impute_mode)
    assert before["missing_pct"] == 0.0
    assert after["missing_pct"] == 0.0
    assert out["city"].isna().sum() == 0


def test_drop_column(df):
    out, before, after = execute_action(df, "dropme", RecommendedAction.drop_column)
    assert "dropme" not in out.columns
    assert after["missing_count"] is None
    assert len(out) == len(df)


def test_clip_outliers_bounds(df):
    df2 = pd.DataFrame({"v": list(range(100)) + [99999, -99999]})
    out, before, after = execute_action(df2, "v", RecommendedAction.clip_outliers)
    assert out["v"].max() <= df2["v"].quantile(0.99)
    assert out["v"].min() >= df2["v"].quantile(0.01)


def test_log_transform_handles_non_positive(df):
    out, _, _ = execute_action(df, "revenue", RecommendedAction.log_transform)
    assert out["revenue"].isna().sum() == 0
    assert (out["revenue"] >= 0).all()


def test_merge_categories_lowercases_and_buckets_rare():
    values = ["New York"] * 70 + ["new york"] * 70 + ["NEW YORK"] * 59 + ["NYC"] * 1
    raw = pd.DataFrame({"city": values})
    out, _, _ = execute_action(raw, "city", RecommendedAction.merge_categories)
    vals = set(out["city"])
    assert "new york" in vals
    assert "nyc" not in vals  # rare category (<1%) merged into "Other"
    assert "Other" in vals


def test_none_is_noop(df):
    out, before, after = execute_action(df, "age", RecommendedAction.none)
    pd.testing.assert_frame_equal(out, df)
    assert before["missing_pct"] == after["missing_pct"]


def test_non_numeric_impute_median_is_safe(df):
    # numeric action on a string column must not raise and must not mutate
    out, _, _ = execute_action(df, "city", RecommendedAction.impute_median)
    assert out["city"].equals(df["city"])
