from __future__ import annotations

from dataclasses import dataclass
import re
import sys


RAW_SCORE_MIN = 0.05
RAW_SCORE_MAX = 6.35
DISPLAY_SCORE_MIN = 0.05
DISPLAY_SCORE_MAX = 2.00


# Tweak these first. Positive numbers add awkwardness; negative numbers add fluency.
WEIGHTS = {
    "base": 0.85,
    "operand_magnitude": 0.55,
    "answer_magnitude": 0.25,
    "three_digit_answer": 0.38,
    "subtraction_extra_load": 0.18,
    "ones_fact_scale": 0.24,
    "addition_carry_base": 0.68,
    "addition_carry_overflow": 0.24,
    "subtraction_borrow_base": 1.00,
    "subtraction_borrow_gap": 0.20,
    "tens_mutation": 0.58,
    "borrow_from_round_ten": 0.20,
    "exact_equality_bonus": -0.90,
    "ones_cancel_bonus": -0.30,
    "round_operand_bonus": -0.18,
    "round_answer_bonus": -0.20,
    "five_anchor_bonus": -0.17,
    "double_fact_bonus": -0.42,
    "near_double_bonus": -0.20,
    "complement_bonus": -0.24,
    "near_ten_shortcut": -0.36,
    "same_tens_bonus": -0.12,
    "neighbor_operands_bonus": -0.10,
    "close_distance_1_to_3_bonus": -2.10,
    "close_distance_4_to_5_bonus": -1.65,
    "close_distance_6_to_10_bonus": -1.10,
    "round_top_small_distance_bonus": -0.70,
    "subtraction_neighbor_bonus": -0.45,
    "near_round_compensation_small_answer_bonus": -0.55,
    "ten_frame_subtraction_bonus": -0.45,
    "answer_awkwardness_scale": 0.12,
    "fingerprint": 0.075,
}


ANSWER_ONES_AWKWARDNESS = {
    0: -0.45,
    1: -0.08,
    2: 0.02,
    3: 0.22,
    4: 0.10,
    5: -0.28,
    6: 0.08,
    7: 0.25,
    8: -0.03,
    9: 0.18,
}


@dataclass(frozen=True)
class Reason:
    name: str
    amount: float
    note: str


@dataclass(frozen=True)
class DifficultyReport:
    label: str
    answer: int
    raw_score: float
    score: float
    reasons: tuple[Reason, ...]


def parse_problem(problem: str) -> tuple[int, str, int]:
    """Parse simple two-number addition/subtraction strings like '56-39'."""
    match = re.fullmatch(r"\s*(\d+)\s*([+-])\s*(\d+)\s*", problem)
    if not match:
        raise ValueError(f"Expected a problem like '56-39' or '57 + 58', got {problem!r}")

    left, op, right = match.groups()
    return int(left), op, int(right)

#only works for + and - right now
def score_problem(left: int, op: str, right: int) -> DifficultyReport:
    if op not in {"+", "-"}:
        raise ValueError(f"Unsupported operator {op!r}; use '+' or '-'")

    if left < 0 or right < 0:
        raise ValueError("This playground expects non-negative whole numbers")

    answer = left + right if op == "+" else left - right
    label = f"{left} {op} {right}"
    reasons: list[Reason] = []

    def add(name: str, amount: float, note: str) -> None:
        if abs(amount) >= 0.005:
            reasons.append(Reason(name, amount, note))

    add("base", WEIGHTS["base"], "starting cost for reading and answering a problem")

    operand_magnitude = ((left + right) / 200) * WEIGHTS["operand_magnitude"]
    add("operand magnitude", operand_magnitude, "bigger visible numbers feel a little heavier")

    answer_magnitude = (abs(answer) / 200) * WEIGHTS["answer_magnitude"]
    add("answer magnitude", answer_magnitude, "larger answers take a little more confidence")

    if abs(answer) >= 100:
        add("three-digit answer", WEIGHTS["three_digit_answer"], "answer crosses into three digits")

    if op == "-":
        add("subtraction load", WEIGHTS["subtraction_extra_load"], "subtraction usually asks for more control than addition")
        _score_subtraction(left, right, answer, add)
    else:
        _score_addition(left, right, answer, add)

    _score_common_fluency(left, op, right, answer, add)

    fingerprint = _fingerprint_nudge(left, op, right)
    add("fingerprint", fingerprint, "tiny deterministic nudge so close equations separate")

    raw_score = max(RAW_SCORE_MIN, sum(reason.amount for reason in reasons))
    return DifficultyReport(
        label=label,
        answer=answer,
        raw_score=raw_score,
        score=_display_score(raw_score),
        reasons=tuple(reasons),
    )


def _display_score(raw_score: float) -> float:
    raw_span = RAW_SCORE_MAX - RAW_SCORE_MIN
    display_span = DISPLAY_SCORE_MAX - DISPLAY_SCORE_MIN
    scaled = DISPLAY_SCORE_MIN + (raw_score - RAW_SCORE_MIN) * (display_span / raw_span)
    bounded = min(DISPLAY_SCORE_MAX, max(DISPLAY_SCORE_MIN, scaled))
    return round(bounded, 2)


def _score_addition(left: int, right: int, answer: int, add) -> None:
    left_ones = left % 10
    right_ones = right % 10
    ones_sum = left_ones + right_ones

    fact = _single_digit_add_fact(left_ones, right_ones)
    add("ones fact", fact, f"ones place asks for {left_ones}+{right_ones}")

    if ones_sum >= 10:
        overflow = ones_sum - 10
        add(
            "carry intensity",
            WEIGHTS["addition_carry_base"] + overflow * WEIGHTS["addition_carry_overflow"],
            f"{left_ones}+{right_ones} makes {ones_sum}, so the carry has overflow {overflow}",
        )
        add("tens mutation", WEIGHTS["tens_mutation"], "carry changes the tens column")

    if left_ones == right_ones and left_ones != 0:
        add("double fact", WEIGHTS["double_fact_bonus"], f"{left_ones}+{right_ones} is a familiar double")

    if abs(left_ones - right_ones) == 1:
        add("near double", WEIGHTS["near_double_bonus"], f"{left_ones} and {right_ones} are neighbors")

    if ones_sum == 10:
        add("complement to ten", WEIGHTS["complement_bonus"], "ones digits make exactly 10")


def _score_subtraction(left: int, right: int, answer: int, add) -> None:
    left_ones = left % 10
    right_ones = right % 10
    left_tens = left // 10

    if right_ones > left_ones:
        borrowed_top = left_ones + 10
        gap = right_ones - left_ones
        fact = _single_digit_sub_fact(borrowed_top, right_ones)
        add("ones fact", fact, f"borrowed ones place asks for {borrowed_top}-{right_ones}")
        add(
            "borrow intensity",
            WEIGHTS["subtraction_borrow_base"] + gap * WEIGHTS["subtraction_borrow_gap"],
            f"ones digit {right_ones} is {gap} past {left_ones}",
        )
        add("tens mutation", WEIGHTS["tens_mutation"], f"borrow changes {left_tens} tens into {left_tens - 1} tens")

        if left_ones == 0:
            add("borrow from round ten", WEIGHTS["borrow_from_round_ten"], "borrowing from a round ten is extra fussy")

        if borrowed_top - right_ones == right_ones:
            add("double fact", WEIGHTS["double_fact_bonus"], f"{right_ones}+{right_ones}={borrowed_top} helps the borrow")

        if right_ones in {8, 9}:
            add("near-ten shortcut", WEIGHTS["near_ten_shortcut"], f"subtracting {right} can be seen as near a ten")
    else:
        fact = _single_digit_sub_fact(left_ones, right_ones)
        add("ones fact", fact, f"ones place asks for {left_ones}-{right_ones}")

    if left == right:
        add("exact equality", WEIGHTS["exact_equality_bonus"], "same number minus itself is almost automatic")

    if left_ones == right_ones:
        add("ones cancel", WEIGHTS["ones_cancel_bonus"], "ones digits cancel cleanly")

    if right % 10 in {8, 9}:
        distance_to_next_ten = 10 - (right % 10)
        add("near-ten shortcut", WEIGHTS["near_ten_shortcut"] / distance_to_next_ten, f"{right} is close to {right + distance_to_next_ten}")

    _score_subtraction_shortcuts(left, right, answer, add)


def _score_subtraction_shortcuts(left: int, right: int, answer: int, add) -> None:
    if answer <= 0:
        return

    if answer <= 3:
        add("close distance", WEIGHTS["close_distance_1_to_3_bonus"], f"{right} to {left} is only {answer}")
    elif answer <= 5:
        add("close distance", WEIGHTS["close_distance_4_to_5_bonus"], f"{right} to {left} is only {answer}")
    elif answer <= 10:
        add("close distance", WEIGHTS["close_distance_6_to_10_bonus"], f"{right} to {left} is a small jump of {answer}")

    if left % 10 == 0 and answer <= 10:
        add("round top shortcut", WEIGHTS["round_top_small_distance_bonus"], f"{left} is a clean ten and the answer is small")

    if answer <= 2:
        add("neighbor subtraction", WEIGHTS["subtraction_neighbor_bonus"], "operands are close enough to count up almost instantly")

    if right % 10 in {8, 9} and answer <= 10:
        next_ten = right + (10 - right % 10)
        add("near-round compensation", WEIGHTS["near_round_compensation_small_answer_bonus"], f"{right} is near {next_ten}, so compensation is available")

    if left == 10 and 5 <= right <= 9:
        add("ten-frame subtraction", WEIGHTS["ten_frame_subtraction_bonus"], f"10-{right} is a familiar ten-frame fact")


def _score_common_fluency(left: int, op: str, right: int, answer: int, add) -> None:
    for value, role in ((left, "left operand"), (right, "right operand")):
        if value % 10 == 0:
            add("round operand", WEIGHTS["round_operand_bonus"], f"{role} {value} ends in 0")
        elif value % 5 == 0:
            add("five anchor", WEIGHTS["five_anchor_bonus"], f"{role} {value} lands on a five")

    if answer % 10 == 0:
        add("round answer", WEIGHTS["round_answer_bonus"], f"answer {answer} ends in 0")
    elif answer % 5 == 0:
        add("five answer", WEIGHTS["five_anchor_bonus"], f"answer {answer} lands on a five")

    left_tens = left // 10
    right_tens = right // 10
    if left_tens == right_tens and left >= 10 and right >= 10:
        add("same tens", WEIGHTS["same_tens_bonus"], "operands live in the same ten-family")

    if abs(left - right) == 1:
        add("neighbor operands", WEIGHTS["neighbor_operands_bonus"], "operands are next-door numbers")

    answer_ones = abs(answer) % 10
    awkwardness = ANSWER_ONES_AWKWARDNESS[answer_ones] * WEIGHTS["answer_awkwardness_scale"]
    add("answer shape", awkwardness, f"answer ending in {answer_ones} has its own feel")

    if op == "+" and (left + right) % 10 == 0:
        add("clean total", WEIGHTS["complement_bonus"], "the whole sum lands on a clean ten")


def _single_digit_add_fact(a: int, b: int) -> float:
    high = max(a, b)
    low = min(a, b)
    effort = high * 0.50 + low * 0.30

    if low == 0:
        effort -= 2.2
    if low == high:
        effort -= 1.35
    if high + low in {5, 10, 15}:
        effort -= 0.55
    if abs(high - low) == 1:
        effort -= 0.38

    return max(0.05, effort * WEIGHTS["ones_fact_scale"])


def _single_digit_sub_fact(top: int, bottom: int) -> float:
    result = top - bottom
    effort = bottom * 0.52 + top * 0.18

    if bottom == 0:
        effort -= 2.0
    if result == 0:
        effort -= 1.6
    if result == bottom:
        effort -= 1.2
    if top in {10, 15, 20}:
        effort -= 0.45
    if bottom in {5, 10} or result in {5, 10}:
        effort -= 0.35
    if bottom in {8, 9}:
        effort += 0.22

    return max(0.05, effort * WEIGHTS["ones_fact_scale"])


def _fingerprint_nudge(left: int, op: str, right: int) -> float:
    op_value = 17 if op == "+" else 31
    mixed = (left * 131 + right * 197 + op_value * 53) % 1000
    centered = (mixed / 999) - 0.5
    return centered * 2 * WEIGHTS["fingerprint"]


def explain(report: DifficultyReport) -> str:
    raw_span = RAW_SCORE_MAX - RAW_SCORE_MIN
    display_span = DISPLAY_SCORE_MAX - DISPLAY_SCORE_MIN
    scaled = DISPLAY_SCORE_MIN + (report.raw_score - RAW_SCORE_MIN) * (display_span / raw_span)
    lines = [
        f"{report.label} = {report.answer}",
        f"score: {report.score:.2f} (raw {report.raw_score:.3f})",
    ]
    for reason in report.reasons:
        sign = "+" if reason.amount >= 0 else "-"
        lines.append(f"  {sign}{abs(reason.amount):.3f} {reason.name}: {reason.note}")
    lines.append(
        f"display scale: {DISPLAY_SCORE_MIN:.2f} + ({report.raw_score:.3f} - {RAW_SCORE_MIN:.2f}) * "
        f"({display_span:.2f} / {raw_span:.2f}) = {scaled:.3f}"
    )
    return "\n".join(lines)


def main() -> None:
    samples = sys.argv[1:] or [
        "10-10",
        "90-87",
        "87-87",
        "5-2",
        "10-5"
    ]

    reports = [score_problem(*parse_problem(sample)) for sample in samples]
    for report in sorted(reports, key=lambda item: item.score):
        print(explain(report))
        print()


if __name__ == "__main__":
    main()
