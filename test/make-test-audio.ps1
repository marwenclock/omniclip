# Makes test/long.wav: a ~6-minute spoken "podcast" with four strong short-form
# moments hidden in filler, using the built-in Windows voice. A good result finds
# all four: "nobody tells you", "worst mistake", "work for free", "biggest lie".
$dir = $PSScriptRoot
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
$s.SetOutputToWaveFile("$dir\long.wav")
$f = @(
"Okay, so let me go through the schedule for this month. The first week is mostly admin, invoices and email. The second week we have two shoots booked, both in the afternoon. The third week is editing, and the fourth week is open for now. I will update the calendar on the website when things are confirmed.",
"A quick note on equipment. I replaced the old tripod with a slightly newer one. It is about the same height and the same weight. The legs lock a little better. Otherwise it is basically identical, so nothing much to report there.",
"Let me read a couple of messages from the forum. Someone asked which file format I export to. I export to the usual format at the usual settings. Someone else asked about my desk setup. It is a normal desk with a normal chair. There is a lamp on the left side.",
"Moving on to software. I updated the editing program last week. The update took about ten minutes. The interface looks the same as before, and I have not noticed any differences yet. I will let you know if anything changes.",
"Now some housekeeping. The newsletter goes out on Thursdays. If you want the links from today, they are in the description below. Please subscribe if you have not already, and thanks to everyone who left a comment last week.",
"Back to the calendar for a moment. I moved the Tuesday meeting to Wednesday, and the Wednesday call moved to Friday. The Friday slot that was open is now taken. So Thursday is the only free day that week, and that is fine.",
"I also reorganized the storage room. The light stands are on the left now and the cables are in labeled boxes on the right. The backdrop rolls are in the corner. It took most of a Saturday, but it looks tidy.",
"For the shoot next Tuesday we will meet at the studio at ten. Parking is on the side street. Bring the usual release forms. The client has asked for the standard package, which is the same as last time, with the same delivery schedule."
)
$h = @(
"Here is something nobody tells you. The client who pays the least will always demand the most. The person paying fifty dollars sends forty emails, and the person paying five thousand sends one email that says looks great, ship it. Once I understood that, I doubled my minimum price, and my stress went down by half overnight.",
"Let me tell you about the worst mistake I ever made. Three years ago I deleted an entire client project the night before delivery. Six weeks of work, gone. I sat on the floor at two in the morning and thought my business was over. Then I remembered one random backup drive in a drawer that I almost threw away. It had everything. That drive saved my career. Back up your work tonight.",
"Should you work for free to build a portfolio? My answer is no, with a twist. Never work for free for a business that makes money. Instead, make the project you wish someone would pay you for, and publish it yourself. Your best client will find you through work nobody asked you to make.",
"The biggest lie in this industry is that you need expensive gear. My most viewed video ever, eleven million views, was shot on a five year old phone propped against a coffee mug. People do not share cameras. They share stories. Spend your money on learning to tell one."
)
$order = @($f[0],$f[1],$f[7],$h[0],$f[2],$f[3],$f[5],$f[6],$h[1],$f[4],$f[0],$f[7],$f[1],$h[2],$f[6],$f[2],$f[5],$f[3],$h[3],$f[7],$f[4])
$s.Speak("Welcome back to the show. " + ($order -join " "))
$s.Dispose()
Write-Output "Wrote $dir\long.wav"
