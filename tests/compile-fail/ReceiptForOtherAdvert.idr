module ReceiptForOtherAdvert
import Recruitment.Adapters.Kernel
%default total

-- An intake handler that answers with a receipt scored against a different advert.
bad : (asked, other : Advert) -> (i : Intake) -> Receipt other -> Reply IntakeC (asked ** i)
bad asked other i receipt = Right receipt
