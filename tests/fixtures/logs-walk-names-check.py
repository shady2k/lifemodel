#!/usr/bin/env python3
"""Report names a walk uses but never imports or defines (ADR-016 stage 2).

Parse a Python file with `ast` and `symtable` and print one
`<path>:<line>: name 'x' is used but never imported or defined` line per
unresolved name, exit 1 when there is one and 0 when there is none. Builtins and
the names a module always receives (`__name__`, `__file__` and friends) count as
defined, and a nested function may use a name its enclosing function binds.
"""
import ast
import builtins
import symtable
import sys

MODULE_NAMES = {
    '__annotations__', '__builtins__', '__cached__', '__dict__', '__doc__',
    '__file__', '__loader__', '__name__', '__package__', '__path__', '__spec__',
}


def bound_names(table):
    names = set()
    for symbol in table.get_symbols():
        if symbol.is_assigned() or symbol.is_imported() or symbol.is_parameter() \
                or symbol.is_namespace():
            names.add(symbol.get_name())
    return names


def walk(table, visible, out):
    """Collect references this scope cannot resolve from `visible` or itself."""
    local = bound_names(table)
    here = visible | local
    for symbol in table.get_symbols():
        if symbol.is_referenced() and symbol.get_name() not in here:
            out.append(symbol.get_name())
    inner = here
    for child in table.get_children():
        # A class body's own names are not visible inside its methods.
        walk(child, visible if table.get_type() == 'class' else inner, out)


def main(paths):
    problems = 0
    for path in paths:
        with open(path, encoding='utf-8') as source:
            text = source.read()
        tree = ast.parse(text, path)
        top = symtable.symtable(text, path, 'exec')
        known = bound_names(top) | set(dir(builtins)) | MODULE_NAMES
        names = []
        walk(top, known, names)
        if names:
            lines = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and node.id in names and node.id not in lines:
                    lines[node.id] = node.lineno
            for name in sorted(set(names)):
                problems += 1
                print('%s:%d: name %r is used but never imported or defined' % (
                    path, lines.get(name, 0), name))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
