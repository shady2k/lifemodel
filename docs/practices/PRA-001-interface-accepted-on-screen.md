# PRA-001 — An interface is accepted on what the deployed build shows, not on what its document or a request says

Status: active
Since: 2026-10-19
Evidence: lifemodel-vhd (vhd.6.4 the login did not stick in a real browser; vhd.6.5 the chat page did not render: the web server's transcript response did not match the app's contract; vhd.6.6 bubbles described as built, absent on screen), lifemodel-3wi9 (3wi9.4.5 the wizard and settings did not look or behave like a wizard and a settings page); retrospective lifemodel-vz26.

## Class
A stage that changes what a person sees is reported done from evidence that does
not pass through the screen: unit tests, a curl of the route, the feature
document's "built so far" list. The defect is then found by the owner.

## Mechanism
Each piece was checked and green: the server answered, the component rendered in
its test, the document listed the behaviour. A curl returns 200 whether or not the
page renders, a cookie works for curl whatever the browser's host rules, and a
document written alongside the code reads as proof of the code. Nothing in the
record asked for the screen.

## Practice
Before a stage that changes an interface is marked implemented, walk it on the
deployed build (the test VM or the assembled image), in real Chromium and Firefox,
in both languages and themes it supports. Take a screenshot of every state the
feature document claims under "built so far" and compare each claim against its
screenshot; a claim without a matching screenshot is removed from the document or
fixed. The screenshots and the browsers used go into the implemented comment.

## How we will know
The next retrospective finds no interface defect reported by the owner that a
screenshot of a claimed state would have shown.
