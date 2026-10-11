# Privacy

Vēlox stores nothing.

- **No accounts.** There is nothing to sign up for.
- **No database.** The server keeps no record of you, your runs or your plan.
- **No logging of what you send.** Tool inputs are used to compute an answer and then discarded.
- **No third parties.** The server does not call Strava, any AI model or any other service.

Your runs travel from Strava to Claude through Strava's own connector, under your Strava and Claude settings. Claude passes the numbers it needs to Vēlox, Vēlox computes and answers, and the answer goes back to Claude. Your training plan lives in your own Claude Project.

The hosting provider (Vercel) keeps standard request metadata such as time, path and status code for operating the service. It does not receive anything Vēlox does not send it, and Vēlox sends it nothing.

The code is open source under AGPL-3.0, so all of the above can be checked.
