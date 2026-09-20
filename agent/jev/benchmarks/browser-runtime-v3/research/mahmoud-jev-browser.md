# MahmoudAdelbghany/jev-browser review

Reviewed 17 September 2026, public revision `20c27dd96df3140cf162c936fbb7aa742c50edc6`. Source was read; its installers, browser tools and paid benchmark were not executed. `package.json` declares ISC; this revision has no separate LICENSE file. Our implementation uses independently written concepts, not copied source.

## Useful concepts

The [agent](https://github.com/MahmoudAdelbghany/jev-browser/blob/20c27dd96df3140cf162c936fbb7aa742c50edc6/src/agent.mjs) runs continuously and returns an explicit escalation when progress needs help. Supplied text values bind to observed fields as joint choices. It checks action/element compatibility and detects repeated state fingerprints. These are useful building blocks for an operation runner: compile literal values once, execute locally, return a structured failure to the planner only when needed.

The [reader](https://github.com/MahmoudAdelbghany/jev-browser/blob/20c27dd96df3140cf162c936fbb7aa742c50edc6/src/snapshot.mjs) combines DOM controls, role, label, local context, field value and viewport state in one observation. Local token overlap ranks a bounded candidate set. This could reduce expensive page-wide prompts, but dropping low-ranked elements can hide the right target. Our current exact-name subset already filters more aggressively; candidate retrieval with fallback should be a separately tested extension.

## What we should keep stronger

Action, element, key and completion questions run independently in one Jev call. Compatibility needs code validation. A model completion probability is not an independent verifier, and any URL/text change is weaker than proving an operation's requested effect. Our snapshot-bound nodes, exact operation postconditions and separate final verifier should remain.

The [published results](https://github.com/MahmoudAdelbghany/jev-browser/blob/20c27dd96df3140cf162c936fbb7aa742c50edc6/RESULTS.md) describe a small mostly local suite and single repetitions for the driver-model comparisons. Its own table includes a live extraction case where the hybrid loses. The [task definitions](https://github.com/MahmoudAdelbghany/jev-browser/blob/20c27dd96df3140cf162c936fbb7aa742c50edc6/bench/tasks.mjs) give Jev prewritten goals/text values, and some answer validators accept any issued code in a task category; Jev state checks sometimes add an exact route. Those are different verification boundaries. Random codes prevent guessing but do not by themselves prove the right item, quantity or complete task. Do not import its headline ratios as our speed/cost evidence.

## Incorporated direction

V4 adds a bounded continuous workflow with literal task arguments, fresh observations per operation, postconditions, trace evidence and structured escalation. Search-and-open remains one operation. It does not add another Jev decision merely to classify an already known action, or replace final verification with model confidence. General forms, cart mutation, payments, canvas and new-window workflows remain outside this candidate.
