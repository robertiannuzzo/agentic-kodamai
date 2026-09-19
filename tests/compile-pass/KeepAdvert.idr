module KeepAdvert
import Recruitment.Core.Score
%default total

keep : (a : Advert) -> Application a -> (Application a, Score a)
keep a app = (app, compute a app)

answers : Answers [MkQuestion 1 "Original question" "yes"]
answers = Answer (MkQuestion 1 "Original question" "yes") "yes" NoAnswers
