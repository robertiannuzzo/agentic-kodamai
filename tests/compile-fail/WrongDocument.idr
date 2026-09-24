module WrongDocument
import Recruitment.Application.Spine
%default total

-- A model leaf that answers with text extracted from a different CV version.
bad : (asked, other : CVInput) -> CVText other -> Reply ExtractionC asked
bad asked other text = Right text
