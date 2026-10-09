"""The console's interpreter driver.

Heeler starts this with `python -u driver.py` and speaks JSON lines
over stdin/stdout: one request in, one reply out.

    {"op": "exec", "code": "1 + 1"}   -> {"out": "", "err": "", "value": "2"}
    {"op": "run", "path": "a.heeler"} -> same shape

Rules of the house:
- One namespace, kept alive across requests. That is what makes this a
  REPL and not a runner.
- Expressions answer with their repr; statements answer with nothing.
  Exactly the interactive-Python contract people expect.
- stdout and stderr are captured per request. Errors come back as a
  traceback in `err`, and the interpreter lives on.
- `heeler` is importable (this file ships beside heeler.py) and the
  connection details ride in on HEELER_API_PORT / HEELER_API_TOKEN,
  so `h = heeler.connect()` just works inside the console.
"""

import ast
import io
import json
import sys
import traceback

# The persistent namespace every request shares. The client is
# preloaded so the first thing typed can be `h = heeler.connect()`.
SPACE = {"__name__": "__console__"}
try:
    import heeler

    SPACE["heeler"] = heeler
except Exception:
    pass


def run(op, code, path):
    if op == "run":
        with open(path, "r", encoding="utf-8") as f:
            code = f.read()
    out, err, value = io.StringIO(), io.StringIO(), None
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        if op == "exec":
            # The scratchboard contract, same as Jupyter's: run the
            # block, and if the LAST statement is an expression, answer
            # with its value. A def plus a call shows the call's result.
            tree = ast.parse(code, "<console>", "exec")
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                head = ast.Module(body=tree.body[:-1], type_ignores=[])
                tail = ast.Expression(tree.body[-1].value)
                exec(compile(head, "<console>", "exec"), SPACE)
                result = eval(compile(tail, "<console>", "eval"), SPACE)
                if result is not None:
                    value = repr(result)
            else:
                exec(compile(tree, "<console>", "exec"), SPACE)
        else:
            exec(compile(code, path, "exec"), SPACE)
    except BaseException:
        traceback.print_exc(file=err)
    finally:
        sys.stdout, sys.stderr = old
    return {"out": out.getvalue(), "err": err.getvalue(), "value": value}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            reply = run(req.get("op", "exec"), req.get("code", ""), req.get("path", ""))
        except Exception as e:
            reply = {"out": "", "err": f"driver error: {e}\n", "value": None}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
