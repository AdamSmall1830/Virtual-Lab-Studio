"""Optional Recursive Agent (Beta).

Delegates a single meeting turn to a worker the researcher runs on their own
machine. Everything here is off by default and fails closed: if the feature is
disabled, no worker is online, or a result does not validate, the meeting stops
and says so rather than substituting a standard completion.
"""
