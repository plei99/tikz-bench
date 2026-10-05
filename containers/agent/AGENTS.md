# Package installation

Install all additional programming-language packages and dependencies locally
inside the current task's working directory. Do not install packages into system,
global, or user-wide environments, and do not modify preinstalled packages.

- Python: create a task-local virtual environment with `python3 -m venv .venv`.
  Install packages with `.venv/bin/python -m pip install ...` and run scripts with
  `.venv/bin/python`.
- JavaScript and TypeScript: install dependencies into the task's local
  `node_modules`; do not use global installs such as `npm install -g`.
- Other languages: use a task-local dependency directory or isolated environment
  and configure the package manager to install there.
