You are working in a checkout of the {repo} repository at {workdir}. Resolve the issue below by editing the source code.

The repository's Python environment exists only inside a Docker container, where this checkout is mounted at /testbed. To run anything that needs that environment (python, the test suite), use:

    {envrun} '<shell command>'

It runs the command from /testbed inside the container. Read and edit files directly in {workdir}.

Do not modify existing tests to make them pass. Tests you add are fine but are not part of your submission. Your submission is the final state of the working tree when you stop.

<issue>
{problem_statement}
</issue>
