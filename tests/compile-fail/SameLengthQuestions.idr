module SameLengthQuestions
import Recruitment.Core.Application
%default total

-- Both lists have one question and the same numeric ID. Contents still differ.
bad : Answers [MkQuestion 1 "Original question" "yes"] ->
      Answers [MkQuestion 1 "Replacement question" "yes"]
bad original = original
