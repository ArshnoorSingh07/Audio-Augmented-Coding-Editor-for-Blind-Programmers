
import sys, os, re, ast, json
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

USE_AI = bool(os.environ.get("USE_AI_FIXER", "") and os.environ.get("GEMINI_API_KEY"))
PRIMARY_MODEL = os.environ.get("GEMINI_MODEL", "models/gemini-2.5-flash")
FALLBACK_MODEL = "models/gemini-pro-latest"

def local_heuristic_fix(code: str):
    fixed = code
    fixed = re.sub(
        r"^(\s*(?:def|for|if|elif|else|while|class)\b[^\n:]*)(?<!:)\s*$",
        lambda m: m.group(1) + ":",
        fixed,
        flags=re.MULTILINE,
    )
    fixed = fixed.replace("\t", "    ")
    fixed = re.sub(r"[ \t]+(\r?\n)", r"\1", fixed)
    fixed = fixed.rstrip() + "\n"
    fixed = re.sub(r"\n{3,}", "\n\n", fixed)
    return fixed, fixed != code


def extract_code_from_response(text: str):
    """Extract code block and JSON summary from Gemini reply"""
    if not text:
        return None, None
    text = text.replace("\r\n", "\n")
    json_summary = None
    m_json = re.search(r"FIXER_JSON\s*:\s*(\{.*\})\s*$", text, flags=re.DOTALL)
    if m_json:
        try:
            json_summary = json.loads(m_json.group(1))
            text = text[:m_json.start()]
        except Exception:
            json_summary = None
    m_code = re.search(r"```(?:python)?\n(.*?)```", text, flags=re.DOTALL)
    if m_code:
        code = m_code.group(1).rstrip() + "\n"
        return code, json_summary
    return text.strip() + "\n", json_summary


def get_gemini_model():
    """Try primary model first, fall back to pro-latest if needed."""
    import google.generativeai as genai

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        print("# GEMINI_API_KEY not found", file=sys.stderr)
        sys.exit(1)

    genai.configure(api_key=key)

    try:
        model = genai.GenerativeModel(PRIMARY_MODEL)
        model.generate_content("ping")  # lightweight test
        print(f"# Using model: {PRIMARY_MODEL}", file=sys.stderr)
        return model
    except Exception as e:
        print(f"# Primary model failed ({PRIMARY_MODEL}): {e}", file=sys.stderr)
        print(f"# Falling back to {FALLBACK_MODEL}", file=sys.stderr)
        try:
            model = genai.GenerativeModel(FALLBACK_MODEL)
            model.generate_content("ping")
            print(f"# Using fallback model: {FALLBACK_MODEL}", file=sys.stderr)
            return model
        except Exception as e2:
            print(f"# Fallback model also failed: {e2}", file=sys.stderr)
            sys.exit(2)


def main():
    if len(sys.argv) < 2:
        print("No file given.", file=sys.stderr)
        sys.exit(1)

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr)
        sys.exit(1)

    code = path.read_text(encoding="utf-8")
    fixed, changed = local_heuristic_fix(code)

    # Try validating heuristic fix
    try:
        ast.parse(fixed)
        print(fixed, end="")
        if changed:
            print("Applied heuristic fixes (colons, indentation, spaces).", file=sys.stderr)
        sys.exit(0)
    except SyntaxError:
        pass

    if USE_AI:
        try:
            import google.generativeai as genai
        except ImportError:
            print(code, end="")
            print("# Please install google-generativeai via pip", file=sys.stderr)
            sys.exit(3)

        model = get_gemini_model()

        system_prompt = (
            "You are an expert Python syntax fixer. "
            "Given possibly broken Python code, output ONLY the corrected code "
            "inside triple backticks. At the end, append one line like: "
            "FIXER_JSON:{\"summary\":\"what changed\",\"changes\":[{\"line\":1,\"type\":\"insert\",\"detail\":\"added :\"}]}"
        )

        user_prompt = f"Fix the following Python code minimally:\n\n=== BEGIN FILE ===\n{code}\n=== END FILE ==="

        try:
            response = model.generate_content([system_prompt, user_prompt])
            reply = response.text
        except Exception as e:
            print(code, end="")
            print(f"# Gemini API error: {e}", file=sys.stderr)
            sys.exit(4)

        new_code, json_summary = extract_code_from_response(reply)
        if new_code:
            try:
                ast.parse(new_code)
                print(new_code, end="")
                if json_summary:
                    print("FIXER_JSON:" + json.dumps(json_summary, separators=(",", ":")), file=sys.stderr)
                else:
                    print("AI-based Gemini fixer applied.", file=sys.stderr)
                sys.exit(0)
            except SyntaxError as e:
                print(code, end="")
                print(f"# Gemini produced invalid syntax at line {e.lineno}: {e.msg}", file=sys.stderr)
                sys.exit(5)
        else:
            print(code, end="")
            print("# Gemini returned no code block", file=sys.stderr)
            sys.exit(6)

    try:
        ast.parse(fixed)
        print(fixed, end="")
        sys.exit(0)
    except SyntaxError as e:
        print(code, end="")
        print(f"# Still has syntax error at line {e.lineno}: {e.msg}", file=sys.stderr)
        sys.exit(7)


if __name__ == "__main__":
    main()

