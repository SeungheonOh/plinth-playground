{-# LANGUAGE NoImplicitPrelude #-}

module LocalMath (addTwo) where

import PlutusTx.Prelude

addTwo :: Integer -> Integer
addTwo value = value + 2
